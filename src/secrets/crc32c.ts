// CRC32C (Castagnoli): the checksum Google Secret Manager sends with a value.
//
// It is not the CRC-32 of zlib and PNG, which the runtime has built in: the
// two use different polynomials and give different numbers for the same bytes.
// A test holds this one to the published check values.

/** One entry for each value of a byte, for the reflected polynomial 0x82F63B78. */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
    // `n` counts from 0 to 255.
    // eslint-disable-next-line security/detect-object-injection
    table[n] = value >>> 0;
  }
  return table;
})();

/** The CRC32C of `bytes`, as a whole number from 0 to 4,294,967,295. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    // The index is one byte: 0 to 255.
    crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
