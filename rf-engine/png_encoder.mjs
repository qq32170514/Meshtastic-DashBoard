import fs from 'fs';
import zlib from 'zlib';

function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
}

const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[i] = c;
}

export function encodeRgbaToPng(width, height, rgbaBuffer) {
    // 1. Signature
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    
    // 2. IHDR Chunk
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8;  // bit depth
    ihdrData[9] = 6;  // RGBA
    ihdrData[10] = 0; // compression
    ihdrData[11] = 0; // filter
    ihdrData[12] = 0; // interlace
    
    const ihdrType = Buffer.from('IHDR');
    const ihdrCrc = Buffer.alloc(4);
    ihdrCrc.writeUInt32BE(crc32(Buffer.concat([ihdrType, ihdrData])), 0);
    
    const ihdrLen = Buffer.alloc(4);
    ihdrLen.writeUInt32BE(13, 0);
    const ihdr = Buffer.concat([ihdrLen, ihdrType, ihdrData, ihdrCrc]);

    // 3. Scanlines with filter byte 0
    const rawScanlines = Buffer.alloc(height * (1 + width * 4));
    let rawOffset = 0;
    let rgbaOffset = 0;
    for (let y = 0; y < height; y++) {
        rawScanlines[rawOffset++] = 0; // filter None
        for (let x = 0; x < width * 4; x++) {
            rawScanlines[rawOffset++] = rgbaBuffer[rgbaOffset++];
        }
    }

    // 4. Deflate
    const compressed = zlib.deflateSync(rawScanlines, { level: 9 });
    const idatLen = Buffer.alloc(4);
    idatLen.writeUInt32BE(compressed.length, 0);
    const idatType = Buffer.from('IDAT');
    const idatCrc = Buffer.alloc(4);
    idatCrc.writeUInt32BE(crc32(Buffer.concat([idatType, compressed])), 0);
    const idat = Buffer.concat([idatLen, idatType, compressed, idatCrc]);

    // 5. IEND Chunk
    const iendLen = Buffer.alloc(4);
    const iendType = Buffer.from('IEND');
    const iendCrc = Buffer.alloc(4);
    iendCrc.writeUInt32BE(crc32(iendType), 0);
    const iend = Buffer.concat([iendLen, iendType, iendCrc]);

    return Buffer.concat([sig, ihdr, idat, iend]);
}
