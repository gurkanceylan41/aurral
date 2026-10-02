import { db } from "../config/db-sqlite.js";
import { jobMatchesTrack } from "./aurralAlbumJobs.js";
import { recordMissingTrackSearch } from "./aurralHistoryService.js";
import { isAnyDownloadSourceConfigured } from "./downloadSourceService.js";
import { libraryManager } from "./libraryManager.js";
import { logger } from "./logger.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_JOB_STATUSES = new Set(["pending", "downloading", "cancel_requested"]);
const UNSEARCHABLE_JOB_STATUSES = new Set(["cancelled", "blocked"]);
const MISSING_TRACK_SEARCH_SETTINGS = { enabled: true, intervalDays: 1 };

const MISSING_TRACK_CONDITION = `
  NOT EXISTS (
    SELECT 1 FROM library_media_files AS media
    WHERE media.track_id = link.track_id AND media.available = 1
  )
`;

const candidateAlbumsStmt = db.prepare(`
  SELECT
    album.id,
    album.title,
    COALESCE(album.mbid, album.release_group_mbid) AS mbid,
    album.artist_id AS artistId,
    artist.name AS artistName,
    artist.mbid AS artistMbid
  FROM library_management AS management
  JOIN library_albums AS album ON album.id = management.entity_id
  JOIN library_artists AS artist ON artist.id = album.artist_id
  WHERE management.entity_kind = 'album'
    AND management.managed_by = 'aurral'
    AND COALESCE(management.monitor_mode, '') != 'unmonitored'
    AND json_valid(album.metadata_json)
    AND json_extract(album.metadata_json, '$.monitored') = 1
    AND (management.last_missing_search_at IS NULL OR management.last_missing_search_at <= ?)
    AND EXISTS (
      SELECT 1 FROM library_album_tracks AS link
      WHERE link.album_id = album.id AND ${MISSING_TRACK_CONDITION}
    )
  ORDER BY COALESCE(management.last_missing_search_at, 0), album.id
`);

const missingTracksStmt = db.prepare(`
  SELECT track.mbid, track.title
  FROM library_album_tracks AS link
  JOIN library_tracks AS track ON track.id = link.track_id
  WHERE link.album_id = ? AND ${MISSING_TRACK_CONDITION}
`);

const markSearchedStmt = db.prepare(`
  UPDATE library_management
  SET last_missing_search_at = ?
  WHERE entity_kind = 'album' AND entity_id = ?
`);

const albumKey = (value) => String(value || "").trim().toLowerCase();

function indexAurralAlbumJobs() {
  const jobsByAlbum = new Map();
  for (const job of downloadTracker.getAll()) {
    if (job.playlistType !== "library" || job.managedBy !== "aurral") continue;
    const key = albumKey(job.albumMbid);
    if (!key) continue;
    const jobs = jobsByAlbum.get(key) || [];
    jobs.push(job);
    jobsByAlbum.set(key, jobs);
  }
  return jobsByAlbum;
}

function hasSearchableMissingTrack(album, jobsByAlbum) {
  const jobs = jobsByAlbum.get(albumKey(album.mbid)) || [];
  if (jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))) return false;
  return missingTracksStmt.all(album.id).some((track) => {
    const latestJob = jobs.filter((job) => jobMatchesTrack(job, track)).at(-1);
    return !UNSEARCHABLE_JOB_STATUSES.has(latestJob?.status);
  });
}

async function searchAlbumMissingTracks(album) {
  try {
    const result = await libraryManager.addAlbum(String(album.artistId), album.mbid, album.title, {
      managedBy: "aurral",
      skipCancelledTracks: true,
    });
    if (result?.error) {
      logger.warn("library", "Missing-track search could not search an album", {
        albumId: album.id,
        message: result.error,
      });
    } else {
      recordMissingTrackSearch({
        albumId: album.id,
        albumName: album.title,
        artistName: album.artistName,
        artistMbid: album.artistMbid,
        queuedTrackCount: result?.queuedTrackCount,
      });
    }
  } catch (error) {
    logger.warn("library", "Missing-track search could not search an album", {
      albumId: album.id,
      message: error?.message || String(error),
    });
  }
  markSearchedStmt.run(Date.now(), album.id);
}

export async function runMissingTrackSearch({ limit = 25 } = {}) {
  const settings = MISSING_TRACK_SEARCH_SETTINGS;
  if (!settings.enabled || !isAnyDownloadSourceConfigured()) return 0;
  const jobsByAlbum = indexAurralAlbumJobs();
  const dueAlbums = [];
  for (const album of candidateAlbumsStmt.all(Date.now() - settings.intervalDays * DAY_MS)) {
    if (dueAlbums.length >= limit) break;
    if (hasSearchableMissingTrack(album, jobsByAlbum)) dueAlbums.push(album);
  }
  for (const album of dueAlbums) await searchAlbumMissingTracks(album);
  return dueAlbums.length;
}
