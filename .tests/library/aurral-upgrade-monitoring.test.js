import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  managementStore,
  { downloadTracker },
  { queueQualityUpgrade, runQualityUpgradeCheck },
] = await setupIsolatedBackend(
  "aurral-upgrade-monitoring",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/qualityProfileService.js",
);

const managedRoot = path.join(isolatedState.baseDir, "managed");
let sequence = 0;

async function createUpgradeCandidate({ albumMonitored = true, trackMonitored = true, inLibrary = true } = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(12, "0");
  const albumMbid = `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  const trackMbid = `dddddddd-dddd-4ddd-8ddd-${suffix}`;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
    mbid: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
    name: `Upgrade Artist ${sequence}`,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `release-group:${albumMbid}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: `Upgrade Album ${sequence}`,
    metadata: { monitored: albumMonitored },
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy: "aurral",
    monitorMode: albumMonitored ? null : "unmonitored",
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `recording:${trackMbid}`,
    mbid: trackMbid,
    title: `Upgrade Track ${sequence}`,
    artistName: artist.name,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  if (!trackMonitored) db.prepare("UPDATE library_tracks SET monitored = 0 WHERE id = ?").run(track.id);

  const filePath = path.join(managedRoot, artist.name, album.title, `${track.title}.mp3`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  if (inLibrary) {
    libraryStore.upsertLibraryMediaFile({ trackId: track.id, albumId: album.id, source: "aurral", path: filePath });
  }

  const jobId = downloadTracker.addJob(
    { artistName: artist.name, trackName: track.title, albumName: album.title, albumMbid, trackMbid },
    "library",
  );
  downloadTracker.setDone(jobId, filePath, album.title);
  downloadTracker.updateQuality(jobId, { tier: "mp3-128", format: "mp3" });
  return jobId;
}

const upgradedJobIds = () =>
  new Set(downloadTracker.getAll().filter((job) => job.upgradeForJobId).map((job) => job.upgradeForJobId));

const originalSettings = dbOps.getSettings();

test.before(async () => {
  await fs.mkdir(managedRoot, { recursive: true });
  dbOps.updateSettings({
    ...originalSettings,
    downloadFolderPath: managedRoot,
    integrations: {
      ...originalSettings.integrations,
      slskd: { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" },
    },
  });
});

test.beforeEach(() => {
  downloadTracker.clearAll();
});

test.after(async () => {
  dbOps.updateSettings(originalSettings);
  await cleanupIsolatedState(isolatedState);
});

test("automatic upgrades skip files in unmonitored albums and unmonitored tracks", async () => {
  const monitored = await createUpgradeCandidate();
  const inUnmonitoredAlbum = await createUpgradeCandidate({ albumMonitored: false });
  const unmonitoredTrack = await createUpgradeCandidate({ trackMonitored: false });
  const outsideLibrary = await createUpgradeCandidate({ inLibrary: false });

  const queued = await runQualityUpgradeCheck({ force: true });

  const upgraded = upgradedJobIds();
  assert.equal(queued, 2);
  assert.equal(upgraded.has(monitored), true);
  assert.equal(upgraded.has(inUnmonitoredAlbum), false);
  assert.equal(upgraded.has(unmonitoredTrack), false);
  assert.equal(upgraded.has(outsideLibrary), true);
});

test("upgrading one frozen track by hand still works", async () => {
  const unmonitoredTrack = await createUpgradeCandidate({ trackMonitored: false });

  assert.equal(await queueQualityUpgrade(downloadTracker.getJob(unmonitoredTrack)), "queued");
  assert.equal(upgradedJobIds().has(unmonitoredTrack), true);
});
