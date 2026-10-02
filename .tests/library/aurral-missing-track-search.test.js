import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  managementStore,
  { downloadTracker },
  { weeklyFlowWorker },
  { lidarrClient },
  { runMissingTrackSearch },
  { SCHEDULED_SYSTEM_TASKS },
  { processSystemTask },
] = await setupIsolatedBackend(
  "aurral-missing-track-search",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/libraryMediaStore.js",
  "backend/services/libraryManagementStore.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/lidarrClient.js",
  "backend/services/aurralMissingTrackSearch.js",
  "backend/services/honkerDb.js",
  "backend/services/systemTaskWorker.js",
);

const DAY_MS = 24 * 60 * 60 * 1000;
const lidarrCalls = [];
let sequence = 0;

function createAlbum({
  managedBy = "aurral",
  monitored = true,
  artistMode = null,
  lastSearchedAt = null,
  tracks = ["missing"],
  withMbid = true,
} = {}) {
  sequence += 1;
  const suffix = String(sequence).padStart(12, "0");
  const artistMbid = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
  const albumMbid = withMbid ? `cccccccc-cccc-4ccc-8ccc-${suffix}` : null;
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: `Search Artist ${sequence}`,
  });
  if (artistMode) {
    managementStore.setLibraryManagement({
      entityKind: "artist",
      entityId: artist.id,
      managedBy: "aurral",
      monitorMode: artistMode,
    });
  }
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: albumMbid ? `release-group:${albumMbid}` : `album:search-album-${sequence}`,
    mbid: albumMbid,
    releaseGroupMbid: albumMbid,
    artistId: artist.id,
    title: `Search Album ${sequence}`,
    metadata: { monitored },
  });
  managementStore.setLibraryManagement({
    entityKind: "album",
    entityId: album.id,
    managedBy,
    monitorMode: monitored ? null : "unmonitored",
  });
  if (lastSearchedAt != null) {
    db.prepare(
      "UPDATE library_management SET last_missing_search_at = ? WHERE entity_kind = 'album' AND entity_id = ?",
    ).run(lastSearchedAt, album.id);
  }
  const jobIds = [];
  const albumTracks = tracks.map((state, index) => {
    const trackMbid = `dddddddd-dddd-4ddd-8ddd-${suffix.slice(2)}${String(index).padStart(2, "0")}`;
    const track = libraryStore.upsertLibraryTrack({
      identityKey: `recording:${trackMbid}`,
      mbid: trackMbid,
      title: `Track ${index + 1}`,
      artistName: artist.name,
    });
    libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: index + 1 });
    if (state === "available") {
      libraryStore.upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: managedBy,
        path: path.join(isolatedState.dataDir, `album-${sequence}`, `${index + 1}.flac`),
      });
    } else if (state !== "missing") {
      const jobId = downloadTracker.addJob(
        {
          artistName: artist.name,
          trackName: track.title,
          albumName: album.title,
          albumMbid,
          trackMbid,
          managedBy: "aurral",
        },
        "library",
      );
      if (state === "failed") downloadTracker.setFailed(jobId, "No matching source result");
      if (state === "cancelled") downloadTracker.setCancelled(jobId);
      if (state === "blocked") downloadTracker.setBlocked(jobId, "Blocked for review");
      jobIds[index] = jobId;
    }
    return { ...track, mbid: trackMbid };
  });
  return { album, albumMbid, tracks: albumTracks, jobIds };
}

const searchTime = (albumId) =>
  db.prepare(
    "SELECT last_missing_search_at FROM library_management WHERE entity_kind = 'album' AND entity_id = ?",
  ).get(albumId)?.last_missing_search_at ?? null;

const albumJobs = (albumMbid) =>
  downloadTracker.getAll().filter((job) => job.albumMbid === albumMbid);

function setDownloadSourceConfigured(configured) {
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      slskd: configured
        ? { enabled: true, url: "http://127.0.0.1:9", apiKey: "test-key" }
        : { enabled: false },
    },
  });
}

const originalSettings = dbOps.getSettings();
const originalLidarr = {
  isConfigured: lidarrClient.isConfigured,
  request: lidarrClient.request,
  getArtist: lidarrClient.getArtist,
  getArtistByMbid: lidarrClient.getArtistByMbid,
};
const originalWorkerStart = weeklyFlowWorker.start;

test.before(() => {
  setDownloadSourceConfigured(true);
  lidarrClient.isConfigured = () => false;
  for (const method of ["request", "getArtist", "getArtistByMbid"]) {
    lidarrClient[method] = async (...args) => {
      lidarrCalls.push([method, ...args]);
      throw new Error("Lidarr must not be called");
    };
  }
  weeklyFlowWorker.start = async () => {};
});

test.beforeEach(() => {
  downloadTracker.clearAll();
  db.prepare("DELETE FROM library_management").run();
  db.prepare("DELETE FROM library_media_files").run();
  db.prepare("DELETE FROM library_album_tracks").run();
  db.prepare("DELETE FROM library_albums").run();
  db.prepare("DELETE FROM library_tracks").run();
  db.prepare("DELETE FROM library_artists").run();
  managementStore.invalidateLibraryManagementCache();
  lidarrCalls.length = 0;
});

test.after(async () => {
  Object.assign(lidarrClient, originalLidarr);
  weeklyFlowWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await cleanupIsolatedState(isolatedState);
});

test("a due album gets its failed and missing tracks queued and one Activity entry", async () => {
  const { album, albumMbid, tracks, jobIds } = createAlbum({ tracks: ["failed", "missing", "available"] });
  const startedAt = Date.now();

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(downloadTracker.getJob(jobIds[0]).status, "pending");
  assert.equal(albumJobs(albumMbid).find((job) => job.trackMbid === tracks[1].mbid)?.status, "pending");
  assert.equal(albumJobs(albumMbid).some((job) => job.trackMbid === tracks[2].mbid), false);
  assert.ok(searchTime(album.id) >= startedAt);
  const albumEntries = dbOps.getAurralHistory({ since: startedAt })
    .filter((entry) => entry.metadata?.albumId === album.id);
  assert.equal(albumEntries.length, 1);
  assert.deepEqual(lidarrCalls, []);
});

test("an album searched within the interval waits while an older search is due", async () => {
  const recent = createAlbum({ lastSearchedAt: Date.now() - 60 * 60 * 1000 });
  const stale = createAlbum({ lastSearchedAt: Date.now() - 2 * DAY_MS });
  const recentSearchTime = searchTime(recent.album.id);

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(albumJobs(recent.albumMbid).length, 0);
  assert.equal(searchTime(recent.album.id), recentSearchTime);
  assert.equal(albumJobs(stale.albumMbid).length, 1);
});

test("the stored interval and switch control the run", async () => {
  const settings = dbOps.getSettings();
  const withinInterval = createAlbum({ lastSearchedAt: Date.now() - 2 * DAY_MS });
  const pastInterval = createAlbum({ lastSearchedAt: Date.now() - 4 * DAY_MS });
  try {
    dbOps.updateSettings({ ...settings, missingTrackSearch: { enabled: false, intervalDays: 3 } });
    assert.equal(await runMissingTrackSearch(), 0);
    assert.equal(albumJobs(pastInterval.albumMbid).length, 0);

    dbOps.updateSettings({ ...settings, missingTrackSearch: { enabled: true, intervalDays: 3 } });
    assert.equal(await runMissingTrackSearch(), 1);
    assert.equal(albumJobs(withinInterval.albumMbid).length, 0);
    assert.equal(albumJobs(pastInterval.albumMbid).length, 1);
  } finally {
    dbOps.updateSettings(settings);
  }
});

test("a run searches at most 25 albums, oldest first, and complete albums do not take a slot", async () => {
  const complete = [
    createAlbum({ tracks: ["available"] }),
    createAlbum({ tracks: ["available", "available"] }),
  ];
  const due = Array.from({ length: 26 }, (_, index) =>
    createAlbum({ lastSearchedAt: Date.now() - (60 - index) * DAY_MS }),
  );

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 25);
  for (const album of due.slice(0, 25)) assert.equal(albumJobs(album.albumMbid).length, 1);
  assert.equal(albumJobs(due[25].albumMbid).length, 0);
  for (const album of complete) assert.equal(searchTime(album.album.id), null);
});

test("only monitored Aurral albums with searchable missing tracks are searched", async () => {
  const unmonitored = createAlbum({ monitored: false });
  const lidarrManaged = createAlbum({ managedBy: "lidarr" });
  const downloading = createAlbum({ tracks: ["pending", "missing"] });
  const cancelledOrBlocked = createAlbum({ tracks: ["cancelled", "blocked", "available"] });
  const underUnmonitoredArtist = createAlbum({ artistMode: "none" });

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 1);
  assert.equal(albumJobs(underUnmonitoredArtist.albumMbid).length, 1);
  for (const skipped of [unmonitored, lidarrManaged, cancelledOrBlocked]) {
    assert.equal(searchTime(skipped.album.id), null);
  }
  assert.equal(albumJobs(unmonitored.albumMbid).length, 0);
  assert.equal(albumJobs(lidarrManaged.albumMbid).length, 0);
  assert.equal(albumJobs(downloading.albumMbid).length, 1);
  assert.equal(searchTime(downloading.album.id), null);
  assert.deepEqual(
    albumJobs(cancelledOrBlocked.albumMbid).map((job) => job.status).sort(),
    ["blocked", "cancelled"],
  );
  assert.deepEqual(lidarrCalls, []);
});

test("without a download source nothing is queued or marked as searched", async () => {
  const { album, albumMbid } = createAlbum();
  setDownloadSourceConfigured(false);
  try {
    assert.equal(await runMissingTrackSearch(), 0);
  } finally {
    setDownloadSourceConfigured(true);
  }

  assert.equal(albumJobs(albumMbid).length, 0);
  assert.equal(searchTime(album.id), null);
});

test("an album that fails is marked as searched and the run continues", async () => {
  const broken = createAlbum({ withMbid: false, lastSearchedAt: Date.now() - 3 * DAY_MS });
  const healthy = createAlbum({ lastSearchedAt: Date.now() - 2 * DAY_MS });
  const startedAt = Date.now();

  const searched = await runMissingTrackSearch();

  assert.equal(searched, 2);
  assert.ok(searchTime(broken.album.id) >= startedAt);
  assert.equal(albumJobs(healthy.albumMbid).length, 1);
});

test("the scheduled system task searches due albums", async () => {
  const scheduled = SCHEDULED_SYSTEM_TASKS.find(
    (task) => task.payload?.kind === "aurral-missing-track-search",
  );
  assert.ok(scheduled, "the missing-track search has a schedule");
  const { albumMbid } = createAlbum({ tracks: ["failed", "missing"] });

  await processSystemTask(scheduled.payload);

  assert.deepEqual(albumJobs(albumMbid).map((job) => job.status), ["pending", "pending"]);
  assert.deepEqual(lidarrCalls, []);
});
