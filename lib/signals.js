/**
 * checkSource.ai — lightweight JPEG/PNG signal probes (no deps)
 * Used by the service worker on raw image bytes.
 */

function probeImageSignals(arrayBuffer, srcUrl = "") {
  const bytes = new Uint8Array(arrayBuffer);
  const format = detectFormat(bytes);
  const exif = format === "jpeg" ? parseJpegExif(bytes) : { present: false, tags: {} };
  const c2pa = detectC2pa(bytes);
  const pngMeta = format === "png" ? probePng(bytes) : null;

  const software = exif.tags.Software || exif.tags.ProcessingSoftware || "";
  const datetime =
    exif.tags.DateTimeOriginal ||
    exif.tags.DateTimeDigitized ||
    exif.tags.DateTime ||
    "";
  const make = exif.tags.Make || "";
  const model = exif.tags.Model || "";

  const editedSoftware = /photoshop|gimp|affinity|lightroom|snapseed|vsco|facetune|picsart|canva|pixelmator/i.test(
    software
  );

  // Social CDNs almost always strip EXIF
  const socialCdn = isSocialCdn(srcUrl);
  const metadataRemoved =
    (format === "jpeg" && !exif.present) ||
    (format === "jpeg" && exif.present && !datetime && !make && !model) ||
    socialCdn;

  let edited = "Unknown";
  if (editedSoftware) edited = "Yes";
  else if (socialCdn && !exif.present) edited = "Likely";
  else if (format === "jpeg" && exif.present && (make || model) && !editedSoftware)
    edited = "No";
  else if (metadataRemoved) edited = "Unknown";

  return {
    format,
    byteLength: bytes.byteLength,
    exif,
    c2pa,
    pngMeta,
    software,
    datetime,
    make,
    model,
    editedSoftware,
    metadataRemoved,
    socialCdn,
    edited,
  };
}

function detectFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "png";
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "webp";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "gif";
  return "unknown";
}

function detectC2pa(bytes) {
  // Look for "c2pa" / "jumb" markers used by Content Credentials
  const hay = bytes.length > 512 * 1024 ? bytes.subarray(0, 512 * 1024) : bytes;
  const text = asciiWindow(hay);
  const present = /c2pa|jumb|c2ma/i.test(text);
  return {
    present,
    detail: present
      ? "Content Credentials (C2PA) markers detected"
      : "No C2PA / Content Credentials markers found",
  };
}

function asciiWindow(bytes) {
  const parts = [];
  const step = 1;
  for (let i = 0; i < bytes.length; i += step) {
    const b = bytes[i];
    parts.push(b >= 32 && b < 127 ? String.fromCharCode(b) : " ");
  }
  return parts.join("");
}

function probePng(bytes) {
  // Scan for tEXt / iTXt / eXIf chunk types
  let hasText = false;
  let hasExif = false;
  let offset = 8;
  while (offset + 8 < bytes.length) {
    const len =
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3];
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") hasText = true;
    if (type === "eXIf") hasExif = true;
    if (type === "IEND") break;
    offset += 12 + len;
    if (len < 0 || offset > bytes.length) break;
  }
  return { hasText, hasExif };
}

function isSocialCdn(url) {
  if (!url) return false;
  return /instagram\.|cdninstagram|fbcdn\.|twimg\.|tiktokcdn|pinimg\.|redd\.it|googleusercontent|ytimg\.|snapchat|linkedin\.|cdn\.discord/i.test(
    url
  );
}

/**
 * Minimal EXIF reader for common TIFF tags inside JPEG APP1.
 */
function parseJpegExif(bytes) {
  const empty = { present: false, tags: {} };
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker === 0xda) break; // SOS
    if (marker === 0xe1) {
      const start = offset + 4;
      const header = String.fromCharCode(
        bytes[start],
        bytes[start + 1],
        bytes[start + 2],
        bytes[start + 3]
      );
      if (header === "Exif") {
        return parseExifTiff(bytes.subarray(start + 6, offset + 2 + size));
      }
    }
    offset += 2 + size;
  }
  return empty;
}

function parseExifTiff(view) {
  const tags = {};
  if (view.length < 8) return { present: false, tags };

  const le = String.fromCharCode(view[0], view[1]) === "II";
  const u16 = (o) => (le ? view[o] | (view[o + 1] << 8) : (view[o] << 8) | view[o + 1]);
  const u32 = (o) =>
    le
      ? view[o] | (view[o + 1] << 8) | (view[o + 2] << 16) | (view[o + 3] << 24)
      : (view[o] << 24) | (view[o + 1] << 16) | (view[o + 2] << 8) | view[o + 3];

  const ifd0 = u32(4);
  readIfd(view, ifd0, le, u16, u32, tags);

  // EXIF sub-IFD
  if (tags._ExifIFD) {
    readIfd(view, tags._ExifIFD, le, u16, u32, tags);
    delete tags._ExifIFD;
  }

  return { present: Object.keys(tags).length > 0, tags };
}

const TAG_MAP = {
  0x010f: "Make",
  0x0110: "Model",
  0x0131: "Software",
  0x0132: "DateTime",
  0x8769: "_ExifIFD",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0xa430: "OwnerName",
  0xa433: "LensMake",
  0xa434: "LensModel",
  0x013b: "Artist",
  0x0112: "Orientation",
};

function readIfd(view, offset, le, u16, u32, tags) {
  if (offset <= 0 || offset + 2 > view.length) return;
  const count = u16(offset);
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > view.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const num = u32(entry + 4);
    const name = TAG_MAP[tag];
    if (!name) continue;

    if (tag === 0x8769 && type === 4) {
      tags._ExifIFD = u32(entry + 8);
      continue;
    }

    // ASCII strings
    if (type === 2) {
      let valueOffset = entry + 8;
      if (num > 4) valueOffset = u32(entry + 8);
      tags[name] = readAscii(view, valueOffset, num);
    } else if (type === 3 && num === 1) {
      tags[name] = u16(entry + 8);
    } else if (type === 4 && num === 1) {
      tags[name] = u32(entry + 8);
    }
  }
}

function readAscii(view, offset, length) {
  if (offset < 0 || offset >= view.length) return "";
  const end = Math.min(view.length, offset + length);
  let s = "";
  for (let i = offset; i < end; i++) {
    const c = view[i];
    if (c === 0) break;
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
  }
  return s.trim();
}
