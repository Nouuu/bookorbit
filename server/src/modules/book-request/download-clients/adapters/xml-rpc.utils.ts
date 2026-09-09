import { BadRequestException } from '@nestjs/common';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

/** What rTorrent sends back. A struct appears only inside a fault, which is thrown, not returned. */
export type XmlRpcValue = string | number | XmlRpcValue[];

/** What a call sends. Every method here takes flat strings, plus a .torrent as base64. */
export type XmlRpcParam = string | number | Buffer;

/**
 * `parseTagValue: false` is what keeps a 40 character hex infohash a string. Left on, an
 * all-digit hash becomes a number and loses its leading zeros, and every hash after that
 * silently fails to match its attempt.
 *
 * `value` and `member` are forced to arrays because fast-xml-parser collapses a single
 * occurrence to the element itself, which would make a one-torrent listing a different shape
 * from a two-torrent one.
 */
const PARSER = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'value' || name === 'member',
});

/** Escaping is the builder's job here, never a hand-rolled replace. */
const BUILDER = new XMLBuilder({ ignoreAttributes: true, format: false });

const DECLARATION = '<?xml version="1.0"?>';

export function encodeMethodCall(method: string, params: XmlRpcParam[]): string {
  return (
    DECLARATION +
    BUILDER.build({
      methodCall: {
        methodName: method,
        params: { param: params.map((param) => ({ value: encodeValue(param) })) },
      },
    })
  );
}

function encodeValue(value: XmlRpcParam): Record<string, unknown> {
  if (Buffer.isBuffer(value)) return { base64: value.toString('base64') };
  // i8 rather than int: rTorrent answers in i8 and accepts it, and a torrent's byte count
  // outgrows a 32-bit int long before a personal library does.
  if (typeof value === 'number') return { i8: Math.trunc(value) };
  return { string: String(value) };
}

export function decodeMethodResponse(xml: string): XmlRpcValue {
  const parsed = parseDocument(xml);
  const response = asRecord(parsed.methodResponse);
  if (!response) throw new BadRequestException('rTorrent did not answer XML-RPC');

  if (response.fault !== undefined) throw faultError(response.fault);

  const params = asRecord(response.params);
  const param = asRecord(params?.param);
  const values = param?.value;
  // A methodResponse with neither a fault nor a param is not something to guess at.
  if (!Array.isArray(values) || values.length === 0) throw new BadRequestException('rTorrent answered XML-RPC with no result');
  return decodeValue(values[0]);
}

function parseDocument(xml: string): Record<string, unknown> {
  try {
    return asRecord(PARSER.parse(xml)) ?? {};
  } catch {
    // A captive portal, a reverse proxy error page, or the plugin's own plain-text refusal all
    // land here, and none of them are worth reporting as a parse failure.
    throw new BadRequestException('rTorrent did not answer XML-RPC');
  }
}

function decodeValue(node: unknown): XmlRpcValue {
  // XML-RPC allows a bare <value>text</value> with no type tag, which means string.
  if (typeof node === 'string') return node;
  const value = asRecord(node);
  if (!value) return '';

  if (value.string !== undefined) return asText(value.string);
  if (value.i8 !== undefined) return Number(value.i8);
  if (value.int !== undefined) return Number(value.int);
  if (value.array !== undefined) return decodeArray(value.array);
  return '';
}

function decodeArray(node: unknown): XmlRpcValue[] {
  const array = asRecord(node);
  // `<data/>` parses to an empty string rather than to an object, which is an empty list.
  const data = asRecord(array?.data);
  const values = data?.value;
  return Array.isArray(values) ? values.map(decodeValue) : [];
}

function faultError(node: unknown): BadRequestException {
  const fault = asRecord(node);
  const values = fault?.value;
  const struct = Array.isArray(values) ? asRecord(asRecord(values[0])?.struct) : null;
  const members = Array.isArray(struct?.member) ? struct.member : [];

  const fields = new Map<string, string>();
  for (const entry of members) {
    const member = asRecord(entry);
    const name = member?.name;
    if (typeof name !== 'string') continue;
    fields.set(name, asText(decodeValue(Array.isArray(member?.value) ? member.value[0] : member?.value)));
  }

  const reason = fields.get('faultString')?.trim();
  const code = fields.get('faultCode')?.trim();
  return new BadRequestException(`rTorrent refused the call${code ? ` (${code})` : ''}: ${reason || 'no reason given'}`);
}

/** Only a primitive becomes text; anything else would stringify to `[object Object]`. */
function asText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
