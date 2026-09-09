import { BadRequestException } from '@nestjs/common';

import { decodeMethodResponse, encodeMethodCall } from './xml-rpc.utils';

/** Collapses the formatting so a test asserts on structure rather than on indentation. */
function compact(xml: string): string {
  return xml.replace(/>\s+</g, '><').trim();
}

describe('encodeMethodCall', () => {
  it('names the method and sends no params when there are none', () => {
    expect(compact(encodeMethodCall('system.client_version', []))).toBe(
      '<?xml version="1.0"?><methodCall><methodName>system.client_version</methodName><params></params></methodCall>',
    );
  });

  it('encodes a string parameter', () => {
    expect(compact(encodeMethodCall('d.name', ['ABC123']))).toContain('<param><value><string>ABC123</string></value></param>');
  });

  it('encodes an integer as i8, which is what rTorrent answers with', () => {
    expect(compact(encodeMethodCall('d.priority.set', [2]))).toContain('<value><i8>2</i8></value>');
  });

  it('encodes a Buffer as base64, which is how a .torrent file is handed over', () => {
    const encoded = compact(encodeMethodCall('load.raw_start', [Buffer.from('torrent bytes')]));
    expect(encoded).toContain(`<value><base64>${Buffer.from('torrent bytes').toString('base64')}</base64></value>`);
  });

  it('escapes a value that would otherwise break the document', () => {
    const encoded = encodeMethodCall('d.custom1.set', ['a & b <c> "d"']);
    expect(encoded).toContain('a &amp; b &lt;c&gt;');
    expect(encoded).not.toContain('<c>');
  });

  it('keeps the parameter order it was given, which is what a multicall field list depends on', () => {
    const encoded = compact(encodeMethodCall('d.multicall2', ['', 'main', 'd.hash=', 'd.name=']));
    expect(encoded.indexOf('d.hash=')).toBeLessThan(encoded.indexOf('d.name='));
    expect(encoded.indexOf('main')).toBeLessThan(encoded.indexOf('d.hash='));
  });
});

describe('decodeMethodResponse', () => {
  it('reads a string answer', () => {
    const xml = '<?xml version="1.0"?><methodResponse><params><param><value><string>0.16.21</string></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toBe('0.16.21');
  });

  it('reads an i8 answer, which is what load.start and d.erase return', () => {
    const xml = '<?xml version="1.0"?><methodResponse><params><param><value><i8>0</i8></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toBe(0);
  });

  it('reads an int answer', () => {
    const xml = '<?xml version="1.0"?><methodResponse><params><param><value><int>42</int></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toBe(42);
  });

  it('reads a bare value with no type tag as a string, which XML-RPC allows', () => {
    const xml = '<?xml version="1.0"?><methodResponse><params><param><value>plain</value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toBe('plain');
  });

  it('reads an empty array as an empty list rather than as nothing', () => {
    const xml = '<?xml version="1.0"?><methodResponse><params><param><value><array><data/></array></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toEqual([]);
  });

  it('reads the nested array a d.multicall2 answer is shaped as', () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><params><param><value><array><data>' +
      '<value><array><data>' +
      '<value><string>0123456789ABCDEF0123456789ABCDEF01234567</string></value>' +
      '<value><string>bookorbit</string></value>' +
      '<value><i8>1024</i8></value>' +
      '</data></array></value>' +
      '</data></array></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toEqual([['0123456789ABCDEF0123456789ABCDEF01234567', 'bookorbit', 1024]]);
  });

  it('keeps a single-element array an array rather than collapsing it to its element', () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><params><param><value><array><data>' +
      '<value><string>only</string></value>' +
      '</data></array></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toEqual(['only']);
  });

  it('keeps a hash that looks numeric as the string it is', () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><params><param><value><string>0123456789012345678901234567890123456789</string></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toBe('0123456789012345678901234567890123456789');
  });

  it('throws the fault rTorrent answers an unknown hash with, carrying its reason', () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><fault><value><struct>' +
      '<member><name>faultCode</name><value><i8>-500</i8></value></member>' +
      '<member><name>faultString</name><value><string>invalid parameters: info-hash not found</string></value></member>' +
      '</struct></value></fault></methodResponse>';
    expect(() => decodeMethodResponse(xml)).toThrow(BadRequestException);
    expect(() => decodeMethodResponse(xml)).toThrow(/info-hash not found/);
  });

  it('throws when the body is an error page rather than an XML-RPC answer', () => {
    expect(() => decodeMethodResponse('<html><body>502 Bad Gateway</body></html>')).toThrow(/did not answer XML-RPC/);
  });

  it('throws when the body is not XML at all', () => {
    expect(() => decodeMethodResponse('Could not reach rTorrent over XMLRPC. Is rTorrent running?')).toThrow(/did not answer XML-RPC/);
  });
});
