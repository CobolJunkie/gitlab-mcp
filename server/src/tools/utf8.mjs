/**
 * Shared strict UTF-8 decoding helpers for repository-backed text.
 */

export function decodeUtf8Strict(bytes, { preserveBom = false } = {}) {
  return new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: preserveBom,
  }).decode(bytes);
}

export function tryDecodeUtf8Strict(bytes, options) {
  try {
    return decodeUtf8Strict(bytes, options);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
