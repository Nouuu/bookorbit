import type { ResolvedClientConfig } from '../download-client-adapter';
import { RtorrentAdapter } from './rtorrent.adapter';

function config(overrides: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
  return {
    id: 1,
    name: 'local rtorrent',
    adapterType: 'rtorrent',
    // 127.0.0.1 needs the per-row private opt-in, which is exactly how a LAN client is configured.
    baseUrl: 'http://127.0.0.1:8080/RPC2',
    username: 'seed',
    password: 'box',
    category: 'bookorbit',
    allowPrivateAddress: true,
    settings: null,
    ...overrides,
  };
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: new Headers({ 'Content-Type': 'text/xml' }) });
}

function methodResponse(inner: string): Response {
  return xmlResponse(`<?xml version="1.0"?><methodResponse><params><param><value>${inner}</value></param></params></methodResponse>`);
}

function mockFetch(handler?: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit; body: string }> = [];
  const fetchMock = vi.fn((url: URL | string, init: RequestInit = {}) => {
    const href = url.toString();
    calls.push({ url: href, init, body: typeof init.body === 'string' ? init.body : '' });
    return Promise.resolve(handler ? handler(href, init) : methodResponse('<string>0.16.21</string>'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('RtorrentAdapter', () => {
  let adapter: RtorrentAdapter;

  beforeEach(() => {
    adapter = new RtorrentAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('identity', () => {
    it('is a torrent client named rtorrent', () => {
      expect(adapter.type).toBe('rtorrent');
      expect(adapter.delivers).toBe('torrent');
      expect(adapter.label).toBe('rTorrent');
    });
  });

  describe('test', () => {
    it('reports the version the instance answers with', async () => {
      mockFetch(() => methodResponse('<string>0.16.21</string>'));

      await expect(adapter.test(config())).resolves.toEqual({ success: true, version: '0.16.21' });
    });

    it('posts to the base URL exactly as given, because it is the endpoint itself', async () => {
      const { calls } = mockFetch();

      await adapter.test(config());

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:8080/RPC2');
      expect(calls[0].body).toContain('<methodName>system.client_version</methodName>');
    });

    it('works against the ruTorrent httprpc endpoint with no special casing', async () => {
      const { calls } = mockFetch();

      await adapter.test(config({ baseUrl: 'http://127.0.0.1:8080/rutorrent/plugins/httprpc/action.php' }));

      expect(calls[0].url).toBe('http://127.0.0.1:8080/rutorrent/plugins/httprpc/action.php');
    });

    it('sends the stored credentials as a Basic header', async () => {
      const { calls } = mockFetch();

      await adapter.test(config());

      const headers = new Headers(calls[0].init.headers);
      expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('seed:box').toString('base64')}`);
    });

    it('sends no authorization header when the instance is unguarded', async () => {
      const { calls } = mockFetch();

      await adapter.test(config({ username: null, password: null }));

      expect(new Headers(calls[0].init.headers).get('authorization')).toBeNull();
    });

    it('says the base URL must be the endpoint when the instance answers 404', async () => {
      mockFetch(() => xmlResponse('<html>404</html>', 404));

      const result = await adapter.test(config());

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/RPC2/);
    });

    it('reports a refused credential rather than an unreachable host when the instance answers 401', async () => {
      mockFetch(() => xmlResponse('Unauthorized', 401));

      const result = await adapter.test(config());

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/credential|password|refused/i);
      expect(result.error).not.toMatch(/RPC2/);
    });

    it('reports a body that is not XML-RPC as such', async () => {
      mockFetch(() => xmlResponse('<html><body>502 Bad Gateway</body></html>'));

      const result = await adapter.test(config());

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/did not answer XML-RPC/i);
    });

    it('reports the fault reason when the instance refuses the call', async () => {
      mockFetch(() =>
        xmlResponse(
          '<?xml version="1.0"?><methodResponse><fault><value><struct>' +
            '<member><name>faultCode</name><value><i8>-501</i8></value></member>' +
            '<member><name>faultString</name><value><string>method not allowed</string></value></member>' +
            '</struct></value></fault></methodResponse>',
        ),
      );

      const result = await adapter.test(config());

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/method not allowed/);
    });

    it('writes nothing to the instance, so a diagnostic never leaves a trace', async () => {
      const { calls } = mockFetch();

      await adapter.test(config());

      const bodies = calls.map((call) => call.body).join('\n');
      // Anchored on a call actually happening: without this the loop below passes on an empty list.
      expect(bodies).toContain('<methodName>system.client_version</methodName>');
      for (const mutating of ['load.start', 'load.raw_start', 'load.normal', 'load.raw', 'd.erase', 'd.custom1.set', 'd.stop', 'd.close']) {
        expect(bodies).not.toContain(mutating);
      }
    });

    it('refuses an address that resolves to a private host when the row has not opted in', async () => {
      mockFetch();

      const result = await adapter.test(config({ allowPrivateAddress: false }));

      expect(result.success).toBe(false);
    });
  });

  describe('sessions', () => {
    it('has no forget to implement, because Basic authentication is sent per request', () => {
      expect('forget' in adapter).toBe(false);
    });

    it('establishes no session, so a second call costs exactly one more request', async () => {
      const { calls } = mockFetch();

      await adapter.test(config());
      await adapter.test(config());

      // Two calls, not three: nothing had to be re-opened between them.
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.body.includes('system.client_version'))).toBe(true);
    });
  });
});

/** The field list `status` and `listOwned` both request, in the order the adapter asks for it. */
function row(overrides: Partial<Record<string, string | number>> = {}): unknown[] {
  const base: Record<string, string | number> = {
    hash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    name: 'A Book',
    custom1: 'bookorbit',
    sizeBytes: 1000,
    completedBytes: 250,
    complete: 0,
    isOpen: 1,
    isActive: 1,
    isHashChecking: 0,
    basePath: '/downloads/A Book',
    message: '',
    ratio: 0,
    upTotal: 0,
    finished: 0,
    ...overrides,
  };
  return [
    base.hash,
    base.name,
    base.custom1,
    base.sizeBytes,
    base.completedBytes,
    base.complete,
    base.isOpen,
    base.isActive,
    base.isHashChecking,
    base.basePath,
    base.message,
    base.ratio,
    base.upTotal,
    base.finished,
  ];
}

function xmlValue(value: unknown): string {
  if (Array.isArray(value)) return `<value><array><data>${value.map(xmlValue).join('')}</data></array></value>`;
  if (typeof value === 'number') return `<value><i8>${value}</i8></value>`;
  return `<value><string>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></value>`;
}

function multicallResponse(rows: unknown[][]): Response {
  return new Response(`<?xml version="1.0"?><methodResponse><params><param>${xmlValue(rows)}</param></params></methodResponse>`, {
    status: 200,
    headers: new Headers({ 'Content-Type': 'text/xml' }),
  });
}

function faultResponse(reason: string, code = -501): Response {
  return new Response(
    `<?xml version="1.0"?><methodResponse><fault><value><struct>` +
      `<member><name>faultCode</name><value><i8>${code}</i8></value></member>` +
      `<member><name>faultString</name><value><string>${reason}</string></value></member>` +
      `</struct></value></fault></methodResponse>`,
    { status: 200, headers: new Headers({ 'Content-Type': 'text/xml' }) },
  );
}

function okResponse(): Response {
  return new Response('<?xml version="1.0"?><methodResponse><params><param><value><i8>0</i8></value></param></params></methodResponse>', {
    status: 200,
    headers: new Headers({ 'Content-Type': 'text/xml' }),
  });
}

/** Routes by the methodName in the request body, which is how these calls actually differ. */
function routeByMethod(routes: Record<string, () => Response>) {
  return (_url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? init.body : '';
    for (const [method, handler] of Object.entries(routes)) {
      if (body.includes(`<methodName>${method}</methodName>`)) return handler();
    }
    return okResponse();
  };
}

describe('RtorrentAdapter grabbing', () => {
  let adapter: RtorrentAdapter;
  const INFO_HASH = 'abcdef0123456789abcdef0123456789abcdef01';

  beforeEach(() => {
    adapter = new RtorrentAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('add', () => {
    it('hands a magnet to load.start and starts it rather than leaving it paused', async () => {
      const { calls } = mockFetch(routeByMethod({}));

      const result = await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config());

      expect(result).toEqual({ clientHash: INFO_HASH });
      expect(calls[0].body).toContain('<methodName>load.start</methodName>');
    });

    it('uploads a .torrent as base64 through load.raw_start rather than asking the instance to fetch a URL', async () => {
      const { calls } = mockFetch(routeByMethod({}));
      const file = Buffer.from('d8:announce...');

      await adapter.add({ torrentFile: file, torrentFileName: 'book.torrent', infoHash: INFO_HASH }, config());

      expect(calls[0].body).toContain('<methodName>load.raw_start</methodName>');
      expect(calls[0].body).toContain(`<base64>${file.toString('base64')}</base64>`);
      expect(calls[0].body).not.toContain('load.start</methodName>');
    });

    it('labels the torrent with the client marker as a trailing load command, so nothing races the magnet', async () => {
      const { calls } = mockFetch(routeByMethod({}));

      await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config());

      expect(calls[0].body).toContain('d.custom1.set=bookorbit');
      expect(calls).toHaveLength(1);
    });

    it('sends the marker verbatim, because rTorrent stores custom1 without encoding it', async () => {
      const { calls } = mockFetch(routeByMethod({}));

      await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config({ category: 'book orbit' }));

      expect(calls[0].body).toContain('d.custom1.set=book orbit');
    });

    it('sends no label command at all when the marker is blank, so an empty label cannot claim every unlabelled torrent', async () => {
      const { calls } = mockFetch(routeByMethod({}));

      await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config({ category: '   ' }));

      expect(calls[0].body).not.toContain('d.custom1.set');
    });

    it('refuses a grab carrying neither a magnet nor a file', async () => {
      mockFetch(routeByMethod({}));

      await expect(adapter.add({ infoHash: INFO_HASH }, config())).rejects.toThrow(/magnet|torrent/i);
    });

    it('adopts a torrent the instance already holds rather than failing the retry forever', async () => {
      const { calls } = mockFetch(
        routeByMethod({
          'load.start': () => faultResponse('duplicate download'),
          'd.name': () =>
            new Response(
              '<?xml version="1.0"?><methodResponse><params><param><value><string>A Book</string></value></param></params></methodResponse>',
              {
                status: 200,
                headers: new Headers({ 'Content-Type': 'text/xml' }),
              },
            ),
        }),
      );

      await expect(adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config())).resolves.toEqual({
        clientHash: INFO_HASH,
        partial: null,
      });
      expect(calls.some((call) => call.body.includes('<methodName>d.name</methodName>'))).toBe(true);
    });

    it('surfaces the original refusal when the instance does not hold the torrent either', async () => {
      mockFetch(
        routeByMethod({
          'load.start': () => faultResponse('something else went wrong'),
          'd.name': () => faultResponse('invalid parameters: info-hash not found', -500),
        }),
      );

      await expect(adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config())).rejects.toThrow(/something else went wrong/);
    });

    it('names an untrusted connection as the cause instead of blaming the release', async () => {
      mockFetch(
        routeByMethod({
          'load.start': () => faultResponse('Command not allowed on untrusted connection: load.start'),
          'd.name': () => faultResponse('invalid parameters: info-hash not found', -500),
        }),
      );

      await expect(adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config())).rejects.toThrow(/untrusted/i);
      await expect(adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config())).rejects.not.toThrow(/could not read/i);
    });

    it('sends the infohash uppercase, which is the only case rTorrent answers to', async () => {
      const { calls } = mockFetch(
        routeByMethod({
          'load.start': () => faultResponse('duplicate download'),
          'd.name': () =>
            new Response(
              '<?xml version="1.0"?><methodResponse><params><param><value><string>A Book</string></value></param></params></methodResponse>',
              {
                status: 200,
                headers: new Headers({ 'Content-Type': 'text/xml' }),
              },
            ),
        }),
      );

      await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config());

      const probe = calls.find((call) => call.body.includes('<methodName>d.name</methodName>'));
      expect(probe?.body).toContain(INFO_HASH.toUpperCase());
    });

    it('reports nothing outstanding when the torrent went in labelled', async () => {
      mockFetch(routeByMethod({}));

      const result = await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config());

      expect(result).toEqual({ clientHash: INFO_HASH });
    });

    it('reports the torrent as unlabelled when even the fallback label call is refused', async () => {
      let loadAttempts = 0;
      mockFetch((_url, init) => {
        const body = typeof init.body === 'string' ? init.body : '';
        if (body.includes('<methodName>load.start</methodName>')) {
          loadAttempts += 1;
          return loadAttempts === 1 ? faultResponse('Command not allowed on untrusted connection: d.custom1.set') : okResponse();
        }
        if (body.includes('<methodName>d.custom1.set</methodName>')) return faultResponse('Command not allowed: d.custom1.set');
        return okResponse();
      });

      const result = await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config());

      expect(result.clientHash).toBe(INFO_HASH);
      expect(result.partial).toEqual({ code: 'torrent_not_labelled', detail: null });
    });

    it('adopts the torrent when the bare retry is refused as a duplicate, rather than recording a failed grab', async () => {
      // rTorrent can create the download and then refuse the trailing command, so the retry hits a
      // duplicate for a torrent the client is already holding.
      const { calls } = mockFetch(
        routeByMethod({
          'load.start': () => faultResponse('Command not allowed on untrusted connection: d.custom1.set'),
          'd.name': () =>
            new Response(
              '<?xml version="1.0"?><methodResponse><params><param><value><string>A Book</string></value></param></params></methodResponse>',
              {
                status: 200,
                headers: new Headers({ 'Content-Type': 'text/xml' }),
              },
            ),
        }),
      );

      const result = await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config());

      expect(result.clientHash).toBe(INFO_HASH);
      expect(result.partial).toEqual({ code: 'torrent_not_labelled', detail: null });
      expect(calls.some((call) => call.body.includes('<methodName>d.name</methodName>'))).toBe(true);
    });

    it('falls back to a separate label call, and still completes the grab, when the load command is refused', async () => {
      let loadAttempts = 0;
      const { calls } = mockFetch((_url, init) => {
        const body = typeof init.body === 'string' ? init.body : '';
        if (body.includes('<methodName>load.start</methodName>')) {
          loadAttempts += 1;
          return loadAttempts === 1 ? faultResponse('Command not allowed on untrusted connection: d.custom1.set') : okResponse();
        }
        return okResponse();
      });

      await expect(adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH }, config())).resolves.toEqual({
        clientHash: INFO_HASH,
        partial: null,
      });
      expect(calls.some((call) => call.body.includes('<methodName>d.custom1.set</methodName>'))).toBe(true);
    });
  });

  describe('status', () => {
    it('asks about every hash in one call, however many are in flight', async () => {
      const { calls } = mockFetch(() => multicallResponse([row(), row({ hash: 'BBBB'.repeat(10) })]));

      await adapter.status([INFO_HASH, 'bbbb'.repeat(10), 'cccc'.repeat(10)], config());

      expect(calls).toHaveLength(1);
      expect(calls[0].body).toContain('<methodName>d.multicall2</methodName>');
    });

    it('asks for the fields in the order toDownloadStatus destructures them', async () => {
      // The only thing tying STATUS_FIELDS to that destructuring is this list. Reordering one
      // without the other reads every field from the wrong position, silently.
      const { calls } = mockFetch(() => multicallResponse([row()]));

      await adapter.status([INFO_HASH], config());

      const asked = [...calls[0].body.matchAll(/<string>(d\.[a-z_.0-9]+=)<\/string>/g)].map((m) => m[1]);
      expect(asked).toEqual([
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
      ]);
    });

    it('does not call at all when nothing is in flight', async () => {
      const { calls } = mockFetch(() => multicallResponse([]));

      await expect(adapter.status([], config())).resolves.toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('lowercases the hashes it reads, so they match the attempts that stored them', async () => {
      mockFetch(() => multicallResponse([row()]));

      const [status] = await adapter.status([INFO_HASH], config());

      expect(status.infoHash).toBe(INFO_HASH);
    });

    it('leaves out a hash the instance no longer knows about rather than reporting an error', async () => {
      mockFetch(() => multicallResponse([row()]));

      const statuses = await adapter.status([INFO_HASH, 'ffff'.repeat(10)], config());

      expect(statuses).toHaveLength(1);
      expect(statuses[0].infoHash).toBe(INFO_HASH);
    });

    it('computes progress from the bytes rather than reading a percentage', async () => {
      mockFetch(() => multicallResponse([row({ sizeBytes: 1000, completedBytes: 250 })]));

      const [status] = await adapter.status([INFO_HASH], config());

      expect(status.progressPercent).toBe(25);
      expect(status.downloadedBytes).toBe(250);
      expect(status.totalBytes).toBe(1000);
    });

    it('treats a magnet with no metadata as an unknown size, not as a one byte download', async () => {
      // Measured: rTorrent reports d.size_bytes as 1 for a magnet whose metadata has not arrived.
      mockFetch(() =>
        multicallResponse([row({ sizeBytes: 1, completedBytes: 0, complete: 0, name: `${'ABCDEF0123456789ABCDEF0123456789ABCDEF01'}.meta` })]),
      );

      const [status] = await adapter.status([INFO_HASH], config());

      expect(status.totalBytes).toBeNull();
      expect(status.progressPercent).toBe(0);
    });

    it('reports no content path while the download is still a session placeholder', async () => {
      // Measured: d.base_path points into .session/<HASH>.meta before metadata arrives, which is
      // not content and which no path mapping covers.
      mockFetch(() =>
        multicallResponse([row({ complete: 0, sizeBytes: 1, basePath: '/data/rtorrent/.session/ABCDEF0123456789ABCDEF0123456789ABCDEF01.meta' })]),
      );

      const [status] = await adapter.status([INFO_HASH], config());

      expect(status.contentPath).toBeNull();
    });

    it('reports the content path once there is real content', async () => {
      mockFetch(() => multicallResponse([row({ complete: 1, completedBytes: 1000 })]));

      const [status] = await adapter.status([INFO_HASH], config());

      expect(status.contentPath).toBe('/downloads/A Book');
    });
  });

  describe('state and messages', () => {
    const state = async (overrides: Parameters<typeof row>[0]) => {
      mockFetch(() => multicallResponse([row(overrides)]));
      const [status] = await adapter.status([INFO_HASH], config());
      return status;
    };

    it('is completed once the bytes are down', async () => {
      expect((await state({ complete: 1, completedBytes: 1000 })).state).toBe('completed');
    });

    it('is queued while the instance is hash checking', async () => {
      expect((await state({ isHashChecking: 1 })).state).toBe('queued');
    });

    it('is queued while the download is closed', async () => {
      expect((await state({ isOpen: 0 })).state).toBe('queued');
    });

    it('is queued while the download is stopped', async () => {
      expect((await state({ isActive: 0 })).state).toBe('queued');
    });

    it('is downloading otherwise', async () => {
      expect((await state({})).state).toBe('downloading');
    });

    it('does not treat an informational tracker note as a refusal', async () => {
      // Measured on an ordinary magnet: this message appears while nothing is wrong.
      const status = await state({ message: 'Tracker: [No DHT nodes available for peer search.]' });

      expect(status.trackerError).toBeUndefined();
      expect(status.state).toBe('downloading');
    });

    it('surfaces a refused announce so it is not mistaken for a torrent with no peers yet', async () => {
      const status = await state({ message: 'Tracker: [Failure reason "unregistered torrent"]' });

      expect(status.trackerError).toContain('unregistered torrent');
      expect(status.state).toBe('downloading');
    });

    it('treats a message that is not from a tracker as a local failure', async () => {
      const status = await state({ message: 'Download registered as completed, but hash check returned unfinished chunks.' });

      expect(status.state).toBe('failed');
      expect(status.errorMessage).toContain('hash check');
    });

    it('truncates a long message rather than carrying a wall of text into the card', async () => {
      const status = await state({ message: `Tracker: [Failure reason "${'x'.repeat(500)}"]` });

      expect(status.trackerError?.length).toBeLessThanOrEqual(200);
    });
  });
});

describe('RtorrentAdapter removal', () => {
  let adapter: RtorrentAdapter;
  const INFO_HASH = 'abcdef0123456789abcdef0123456789abcdef01';

  beforeEach(() => {
    adapter = new RtorrentAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('erases the torrent and leaves the data alone when deletion was not asked for', async () => {
    const { calls } = mockFetch(routeByMethod({}));

    const report = await adapter.remove(INFO_HASH, config(), { deleteFiles: false });

    expect(report).toEqual({ requested: false, deleted: false, leftAt: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain('<methodName>d.erase</methodName>');
  });

  it('sends the hash uppercase, which is the only case rTorrent answers to', async () => {
    const { calls } = mockFetch(routeByMethod({}));

    await adapter.remove(INFO_HASH, config(), { deleteFiles: false });

    expect(calls[0].body).toContain(INFO_HASH.toUpperCase());
  });

  it('never claims to have deleted the data, because rTorrent has no call that does, and says where it is', async () => {
    const { calls } = mockFetch(
      routeByMethod({
        'd.base_path': () =>
          new Response(
            '<?xml version="1.0"?><methodResponse><params><param><value><string>/downloads/A Book</string></value></param></params></methodResponse>',
            { status: 200, headers: new Headers({ 'Content-Type': 'text/xml' }) },
          ),
      }),
    );

    const report = await adapter.remove(INFO_HASH, config(), { deleteFiles: true });

    expect(report).toEqual({ requested: true, deleted: false, leftAt: '/downloads/A Book' });
    expect(calls.some((call) => call.body.includes('<methodName>d.erase</methodName>'))).toBe(true);
    expect(calls.every((call) => call.url === 'http://127.0.0.1:8080/RPC2')).toBe(true);
  });

  it('reads the path before erasing, since the erase takes the only record of it', async () => {
    const { calls } = mockFetch(routeByMethod({}));

    await adapter.remove(INFO_HASH, config(), { deleteFiles: true });

    const order = calls.map((call) => (call.body.includes('d.base_path') ? 'path' : call.body.includes('d.erase') ? 'erase' : 'other'));
    expect(order.indexOf('path')).toBeLessThan(order.indexOf('erase'));
  });

  it('treats erasing a torrent the instance does not hold as a completed removal', async () => {
    mockFetch(routeByMethod({ 'd.erase': () => faultResponse('invalid parameters: info-hash not found', -500) }));

    await expect(adapter.remove(INFO_HASH, config(), { deleteFiles: false })).resolves.toEqual({
      requested: false,
      deleted: false,
      leftAt: null,
    });
  });
});

describe('RtorrentAdapter reconciliation', () => {
  let adapter: RtorrentAdapter;

  beforeEach(() => {
    adapter = new RtorrentAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('can enumerate what it holds, so the settings page never claims otherwise', async () => {
    mockFetch(() => multicallResponse([row()]));

    await expect(adapter.listOwned(config())).resolves.toMatchObject({ supported: true, truncated: false });
  });

  it('lists only the torrents carrying the client marker', async () => {
    mockFetch(() =>
      multicallResponse([
        row({ hash: 'AAAA'.repeat(10), custom1: 'bookorbit' }),
        row({ hash: 'BBBB'.repeat(10), custom1: 'something else' }),
        row({ hash: 'CCCC'.repeat(10), custom1: '' }),
      ]),
    );

    const inventory = await adapter.listOwned(config());

    expect(inventory.items.map((item) => item.infoHash)).toEqual(['aaaa'.repeat(10)]);
  });

  it('answers with the same call the poll uses, so reconciliation costs one request', async () => {
    const { calls } = mockFetch(() => multicallResponse([row()]));

    await adapter.listOwned(config());

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain('<methodName>d.multicall2</methodName>');
  });

  it('names an item by its torrent name, falling back to the hash when there is none', async () => {
    mockFetch(() => multicallResponse([row({ name: 'A Book' }), row({ hash: 'BBBB'.repeat(10), name: '' })]));

    const inventory = await adapter.listOwned(config());

    expect(inventory.items.map((item) => item.name)).toEqual(['A Book', 'bbbb'.repeat(10)]);
  });

  it('says the list was truncated rather than passing a partial list off as complete', async () => {
    mockFetch(() => multicallResponse(Array.from({ length: 1001 }, (_, index) => row({ hash: index.toString(16).padStart(40, '0').toUpperCase() }))));

    const inventory = await adapter.listOwned(config());

    expect(inventory.truncated).toBe(true);
    expect(inventory.items).toHaveLength(1000);
  });

  it('does not claim support when there is no marker to filter on', async () => {
    mockFetch(() => multicallResponse([row()]));

    // A blank marker would match every unlabelled torrent in the instance, which is the opposite
    // of telling BookOrbit's own torrents apart.
    await expect(adapter.listOwned(config({ category: '  ' }))).resolves.toEqual({ supported: false, truncated: false, items: [] });
  });

  it('carries the same progress and state the poll reports, so an adopted item resumes correctly', async () => {
    mockFetch(() => multicallResponse([row({ sizeBytes: 1000, completedBytes: 500 })]));

    const [item] = (await adapter.listOwned(config())).items;

    expect(item.progressPercent).toBe(50);
    expect(item.state).toBe('downloading');
  });
});

describe('RtorrentAdapter seeding', () => {
  let adapter: RtorrentAdapter;
  const INFO_HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  const NOW = new Date('2026-09-09T12:00:00Z');

  beforeEach(() => {
    adapter = new RtorrentAdapter();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const seed = async (overrides: Parameters<typeof row>[0]) => {
    mockFetch(() => multicallResponse([row(overrides)]));
    const [status] = await adapter.status([INFO_HASH], config());
    return status.seed;
  };

  it('reports a finished torrent the instance is still running as seeding', async () => {
    expect(await seed({ complete: 1, completedBytes: 1000, isActive: 1 })).toMatchObject({ seeding: true });
  });

  it('does not call a stopped torrent seeding', async () => {
    expect(await seed({ complete: 1, completedBytes: 1000, isActive: 0 })).toMatchObject({ seeding: false });
  });

  it('converts the ratio out of the per mille rTorrent reports it in', async () => {
    expect(await seed({ complete: 1, completedBytes: 1000, ratio: 1500 })).toMatchObject({ ratio: 1.5 });
  });

  it('derives the seeding time from when the download finished, because rTorrent counts no seconds', async () => {
    const finished = Math.floor(NOW.getTime() / 1000) - 3600;

    expect(await seed({ complete: 1, completedBytes: 1000, finished })).toMatchObject({ seedingTimeSeconds: 3600 });
  });

  it('reports no seeding time while the download has not finished', async () => {
    expect(await seed({ complete: 0, finished: 0 })).toMatchObject({ seedingTimeSeconds: null });
  });

  it('reports the uploaded bytes', async () => {
    expect(await seed({ complete: 1, completedBytes: 1000, upTotal: 4096 })).toMatchObject({ uploadedBytes: 4096 });
  });

  it('never claims a goal, because BookOrbit sets neither on this client type', async () => {
    expect(await seed({ complete: 1, completedBytes: 1000, ratio: 2000 })).toMatchObject({
      ratioGoal: null,
      seedingTimeGoalMinutes: null,
    });
  });

  it('sends no ratio or seed time command even when the release carries goals, and still grabs', async () => {
    const { calls } = mockFetch(routeByMethod({}));

    const result = await adapter.add({ magnet: 'magnet:?xt=urn:btih:ABC', infoHash: INFO_HASH, seedRatioGoal: 2, seedTimeMinutes: 4320 }, config());

    expect(result.clientHash).toBe(INFO_HASH);
    const bodies = calls.map((call) => call.body).join('\n');
    for (const absent of ['ratio', 'seeding', 'seed_time', 'group.seeding']) {
      expect(bodies.toLowerCase()).not.toContain(absent);
    }
  });
});
