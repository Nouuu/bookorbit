import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { DownloadClientTestResult, DownloadFileRemoval, PartialOutcome } from '@bookorbit/types';

import { sanitizeLogValue } from '../../../../common/utils/log-sanitize.utils';
import { ensureSafeUrl } from '../../../../common/utils/ssrf.utils';
import type {
  DownloadClientAdapter,
  DownloadState,
  DownloadStatus,
  GrabPayload,
  OwnedDownloadClientInventory,
  ResolvedClientConfig,
} from '../download-client-adapter';
import { basicAuthHeader, fetchClient, readClientText, throwForClientServerError } from './client-http.utils';
import { decodeMethodResponse, encodeMethodCall, type XmlRpcParam, type XmlRpcValue } from './xml-rpc.utils';

const LABEL = 'rTorrent';

const MAIN_VIEW = 'main';

/** `toDownloadStatus` reads the answer back by position, so this order binds. */
const STATUS_FIELDS = [
  'd.hash=',
  'd.name=',
  'd.custom1=',
  'd.size_bytes=',
  'd.completed_bytes=',
  'd.complete=',
  'd.is_open=',
  'd.is_active=',
  'd.is_hash_checking=',
  'd.base_path=',
  'd.message=',
  'd.ratio=',
  'd.up.total=',
  'd.timestamp.finished=',
];

/** The two positions `listOwned` reads without building a full status. */
const NAME = 1;
const MARKER = 2;

const MESSAGE_LIMIT = 200;

/** Same cap the other three adapters apply: a seedbox holds far more than a page should render. */
const RECONCILIATION_LIMIT = 1000;

const TRACKER_MESSAGE = /^tracker:/i;

/** A healthy magnet reports `Tracker: [No DHT nodes available for peer search.]`, so the prefix
 * alone is not a failure. */
const TRACKER_FAILURE =
  /failure reason|unregistered|not registered|denied|unauthoriz|forbidden|could ?n[o']?t connect|connection (timed out|refused)|error/i;

/**
 * The base URL is the XML-RPC endpoint itself, `/RPC2` behind nginx or ruTorrent's
 * `plugins/httprpc/action.php`, so the same adapter serves both. No `forget`: Basic auth is sent
 * per request, so no session outlives a config change.
 */
@Injectable()
export class RtorrentAdapter implements DownloadClientAdapter {
  readonly type = 'rtorrent' as const;
  readonly label = LABEL;
  readonly delivers = 'torrent' as const;

  private readonly logger = new Logger(RtorrentAdapter.name);

  async add(release: GrabPayload, config: ResolvedClientConfig): Promise<{ clientHash: string; partial?: PartialOutcome | null }> {
    if (!release.torrentFile && !release.magnet) {
      throw new BadRequestException('A grab needs either a magnet link or a .torrent file');
    }

    const hash = release.infoHash.toLowerCase();
    const label = markerLabel(config.category);

    try {
      await this.load(config, release, label ? [`d.custom1.set=${label}`] : []);
      return { clientHash: hash };
    } catch (error) {
      // Took the torrent but not the label command: the transfer is what matters, so retry bare.
      if (label && error instanceof Error && error.message.includes('d.custom1.set')) {
        return this.loadThenLabel(release, config, hash, label);
      }
      return this.adoptOrFail(error, hash, config, null);
    }
  }

  /** rTorrent may create the download before refusing the trailing command, so the bare retry can
   * hit a duplicate and still needs the adoption path. */
  private async loadThenLabel(
    release: GrabPayload,
    config: ResolvedClientConfig,
    hash: string,
    label: string,
  ): Promise<{ clientHash: string; partial?: PartialOutcome | null }> {
    const unlabelled: PartialOutcome = { code: 'torrent_not_labelled', detail: null };
    try {
      await this.load(config, release, []);
    } catch (error) {
      return this.adoptOrFail(error, hash, config, unlabelled);
    }

    // Unlabelled still downloads, but reconciliation will not find it later.
    const labelled = await this.applyLabel(hash, label, config);
    return { clientHash: hash, partial: labelled ? null : unlabelled };
  }

  /** A failed import leaves the torrent behind, so without this every retry is refused forever. */
  private async adoptOrFail(
    error: unknown,
    hash: string,
    config: ResolvedClientConfig,
    partial: PartialOutcome | null,
  ): Promise<{ clientHash: string; partial?: PartialOutcome | null }> {
    if (await this.holds(hash, config)) {
      this.logger.log(`[download_client.add] [end] clientId=${config.id} hash=${hash} adopted=true - the client already held this torrent`);
      return { clientHash: hash, partial };
    }
    throw addFailure(error);
  }

  async status(hashes: string[], config: ResolvedClientConfig): Promise<DownloadStatus[]> {
    // An empty filter would pull the instance's entire queue to answer a poll about nothing.
    if (hashes.length === 0) return [];

    const wanted = new Set(hashes.map((hash) => hash.toLowerCase()));
    const rows = await this.multicall(config);
    return rows.flatMap((row) => {
      const status = toDownloadStatus(row);
      return status && wanted.has(status.infoHash) ? [status] : [];
    });
  }

  /** rTorrent has no hash-filtered multicall, so the whole view comes back and is filtered here. */
  private async multicall(config: ResolvedClientConfig): Promise<XmlRpcValue[][]> {
    const answer = await this.call(config, 'd.multicall2', ['', MAIN_VIEW, ...STATUS_FIELDS]);
    if (!Array.isArray(answer)) return [];
    return answer.filter((row): row is XmlRpcValue[] => Array.isArray(row));
  }

  private async load(config: ResolvedClientConfig, release: GrabPayload, commands: string[]): Promise<void> {
    if (release.torrentFile) {
      await this.call(config, 'load.raw_start', ['', release.torrentFile, ...commands]);
      return;
    }
    await this.call(config, 'load.start', ['', release.magnet ?? '', ...commands]);
  }

  /** Best effort: the bytes are already moving, so a refused label must not fail the grab. */
  private async applyLabel(hash: string, label: string, config: ResolvedClientConfig): Promise<boolean> {
    try {
      await this.call(config, 'd.custom1.set', [hash.toUpperCase(), label]);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[download_client.label] [fail] clientId=${config.id} hash=${hash} error="${sanitizeLogValue(detail)}" - the torrent was added but could not be labelled`,
      );
      return false;
    }
  }

  /** Any failure to find out answers "no", so an unreachable instance surfaces the add failure. */
  private async holds(hash: string, config: ResolvedClientConfig): Promise<boolean> {
    // Any failure to find out answers "no", so an unreachable instance surfaces the add failure.
    try {
      await this.call(config, 'd.name', [hash.toUpperCase()]);
      return true;
    } catch {
      return false;
    }
  }

  async listOwned(config: ResolvedClientConfig): Promise<OwnedDownloadClientInventory> {
    const label = markerLabel(config.category);
    // A blank marker would claim every unlabelled torrent in the instance.
    if (!label) return { supported: false, truncated: false, items: [] };

    const owned = (await this.multicall(config)).filter((row) => text(row[MARKER]) === label);
    return {
      supported: true,
      truncated: owned.length > RECONCILIATION_LIMIT,
      items: owned.slice(0, RECONCILIATION_LIMIT).flatMap((row) => {
        const status = toDownloadStatus(row);
        return status ? [{ ...status, name: text(row[NAME]).trim() || status.infoHash }] : [];
      }),
    };
  }

  async remove(hash: string, config: ResolvedClientConfig, opts: { deleteFiles: boolean }): Promise<DownloadFileRemoval> {
    // rTorrent's own erase never touches the data, and there is no rtorrent call that does.
    const leftAt = opts.deleteFiles ? await this.contentLocation(hash, config) : null;
    await this.erase(hash, config);
    if (opts.deleteFiles) {
      this.logger.warn(
        `[download_client.remove] [end] clientId=${config.id} hash=${hash.toLowerCase()} deleteFiles=true filesDeleted=false leftAt="${sanitizeLogValue(leftAt ?? '')}" - the torrent was removed, rTorrent cannot delete its data`,
      );
    }
    return { requested: opts.deleteFiles, deleted: false, leftAt };
  }

  /** A hash the instance no longer holds is a completed removal, not a failure. */
  private async erase(hash: string, config: ResolvedClientConfig): Promise<void> {
    try {
      await this.call(config, 'd.erase', [hash.toUpperCase()]);
    } catch (error) {
      if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
    }
  }

  private async contentLocation(hash: string, config: ResolvedClientConfig): Promise<string | null> {
    try {
      return contentPath(text(await this.call(config, 'd.base_path', [hash.toUpperCase()])));
    } catch {
      return null;
    }
  }

  async test(config: ResolvedClientConfig): Promise<DownloadClientTestResult> {
    try {
      const version = await this.call(config, 'system.client_version', []);
      return { success: true, version: typeof version === 'string' && version.trim() ? version.trim() : undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[download_client.test] [fail] clientId=${config.id} error="${sanitizeLogValue(message)}" - rTorrent connection test failed`);
      return { success: false, error: message };
    }
  }

  /** One XML-RPC call. Every member goes through here, so the SSRF check is never skipped. */
  private async call(config: ResolvedClientConfig, method: string, params: XmlRpcParam[]): Promise<XmlRpcValue> {
    const base = await ensureSafeUrl(config.baseUrl, { allowPrivate: config.allowPrivateAddress });
    const response = await fetchClient(
      base,
      {
        method: 'POST',
        body: encodeMethodCall(method, params),
        headers: { 'Content-Type': 'text/xml', ...basicAuthHeader(config.username, config.password) },
      },
      LABEL,
    );

    if (!response.ok) throw transportError(response, method);
    return decodeMethodResponse(await readClientText(response, LABEL));
  }
}

/** A 404 and a 401 are fixed in different places, so they must not read the same. */
function transportError(response: Response, method: string): Error {
  if (response.status === 404) {
    return new BadRequestException(
      'rTorrent answered 404 at that address. The base URL must be the XML-RPC endpoint itself, usually /RPC2, or plugins/httprpc/action.php behind ruTorrent.',
    );
  }
  if (response.status === 401 || response.status === 403) return new BadRequestException('rTorrent refused those credentials');

  throwForClientServerError(response, LABEL, method);
  return new BadRequestException(`rTorrent answered ${response.status} for ${method}`);
}

/** rTorrent stores `custom1` verbatim and the category charset holds nothing it mangles, so only
 * a blank marker has to be rejected. */
function markerLabel(category: string): string | null {
  return category.trim() || null;
}

/** rTorrent's untrusted-connection mode answers every read and refuses new torrents. Calling that
 * an unreadable torrent sends the operator to examine the wrong thing. */
function addFailure(error: unknown): Error {
  if (error instanceof Error && /untrusted/i.test(error.message)) {
    return new BadRequestException(
      `rTorrent refused to add the torrent on an untrusted connection. Allow the load commands on this instance. (${error.message})`,
    );
  }
  return error instanceof Error ? error : new BadRequestException(String(error));
}

function toDownloadStatus(row: XmlRpcValue[]): DownloadStatus | null {
  const [rawHash, rawName, , rawSize, rawDone, rawComplete, rawOpen, rawActive, rawChecking, rawPath, rawMessage, rawRatio, rawUp, rawFinished] = row;
  const hash = text(rawHash).toLowerCase();
  if (!hash) return null;

  const sizeBytes = count(rawSize);
  const complete = count(rawComplete) === 1;
  const active = count(rawActive) === 1;
  const routed = routeMessage(text(rawMessage));
  // A magnet reads one byte and `<HASH>.meta` until its metadata arrives.
  const totalBytes = !text(rawName).endsWith('.meta') && sizeBytes > 1 ? sizeBytes : null;
  const downloadedBytes = count(rawDone);
  const finishedAt = count(rawFinished);
  const ratio = count(rawRatio);

  let state: DownloadState = 'downloading';
  if (routed.errorMessage !== undefined) state = 'failed';
  else if (complete) state = 'completed';
  else if (count(rawChecking) === 1 || count(rawOpen) !== 1 || !active) state = 'queued';

  return {
    infoHash: hash,
    state,
    progressPercent: totalBytes ? Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))) : 0,
    downloadedBytes,
    totalBytes,
    contentPath: contentPath(text(rawPath)),
    seed: {
      seeding: complete && active,
      // Per mille, and there is no seeding-seconds counter, so the time is derived. Goals stay
      // null: rTorrent enforces ratio per group from its rc file, not per torrent.
      ratio: ratio >= 0 ? ratio / 1000 : null,
      ratioGoal: null,
      seedingTimeSeconds: finishedAt > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - finishedAt) : null,
      seedingTimeGoalMinutes: null,
      uploadedBytes: Math.max(0, count(rawUp)),
    },
    ...routed,
  };
}

/** Before metadata, `d.base_path` points into `.session`, which no path mapping covers. */
function contentPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed.endsWith('.meta') || /(^|\/)\.session(\/|$)/.test(trimmed)) return null;
  return trimmed;
}

function routeMessage(message: string): { trackerError?: string; errorMessage?: string } {
  const text = message.trim();
  if (!text) return {};
  if (TRACKER_MESSAGE.test(text)) return TRACKER_FAILURE.test(text) ? { trackerError: text.slice(0, MESSAGE_LIMIT) } : {};
  return { errorMessage: text.slice(0, MESSAGE_LIMIT) };
}

function text(value: XmlRpcValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function count(value: XmlRpcValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
