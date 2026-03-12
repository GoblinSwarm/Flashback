// src/snapshot/webmKeyframe.ts
// ======================================================
//
// Lightweight WebM keyframe detection
// -----------------------------------
//
// Objetivo:
// - detectar de forma heurística si un blob WebM contiene
//   al menos un bloque de video marcado como keyframe
//
// Alcance:
// - pensado como utilidad liviana para mejorar el punto
//   de arranque del snapshot MSE
// - NO reemplaza un parser EBML completo
//
// Limitaciones:
// - asume estructura WebM razonablemente estándar
// - está orientado a blobs MediaRecorder típicos
// - puede tener falsos negativos en casos raros
//

function readVintLength(firstByte: number): number {
  if ((firstByte & 0b10000000) !== 0) return 1;
  if ((firstByte & 0b01000000) !== 0) return 2;
  if ((firstByte & 0b00100000) !== 0) return 3;
  if ((firstByte & 0b00010000) !== 0) return 4;
  if ((firstByte & 0b00001000) !== 0) return 5;
  if ((firstByte & 0b00000100) !== 0) return 6;
  if ((firstByte & 0b00000010) !== 0) return 7;
  if ((firstByte & 0b00000001) !== 0) return 8;
  return 1;
}

function startsWithSimpleBlock(data: Uint8Array, offset: number): boolean {
  // SimpleBlock EBML ID = 0xA3
  return data[offset] === 0xa3;
}

function looksLikeVideoTrackNumber(trackNumber: number): boolean {
  // Heurística simple:
  // en la mayoría de capturas MediaRecorder WebM, el track de video
  // suele ser pequeño (1 o 2). No queremos aceptar números absurdos.
  return trackNumber >= 1 && trackNumber <= 4;
}

function extractSimpleBlockInfo(
  data: Uint8Array,
  offset: number
): { isKeyframe: boolean; isVideoLike: boolean } | null {
  if (!startsWithSimpleBlock(data, offset)) {
    return null;
  }

  // Estructura esperada:
  // [A3][size-vint][track-vint][timecode(2)][flags(1)]...
  let cursor = offset + 1;
  if (cursor >= data.length) return null;

  const sizeLen = readVintLength(data[cursor]);
  cursor += sizeLen;
  if (cursor >= data.length) return null;

  const trackFirstByte = data[cursor];
  const trackLen = readVintLength(trackFirstByte);
  if (cursor + trackLen > data.length) return null;

  // Parse mínimo del track number como vint
  let trackNumber = trackFirstByte & (0xff >> trackLen);
  for (let i = 1; i < trackLen; i++) {
    trackNumber = (trackNumber << 8) | data[cursor + i];
  }

  cursor += trackLen;

  // timecode(2) + flags(1)
  if (cursor + 3 > data.length) return null;

  cursor += 2; // skip signed timecode
  const flags = data[cursor];

  // En SimpleBlock:
  // bit 7 (0x80) = keyframe
  const isKeyframe = (flags & 0x80) !== 0;

  return {
    isKeyframe,
    isVideoLike: looksLikeVideoTrackNumber(trackNumber),
  };
}

export async function blobContainsWebmKeyframe(blob: Blob): Promise<boolean> {
  if (!blob || blob.size <= 0) {
    return false;
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());

  // Scan lineal simple.
  // Buscamos SimpleBlock (0xA3) y miramos su flag de keyframe.
  for (let i = 0; i < bytes.length - 8; i++) {
    if (bytes[i] !== 0xa3) {
      continue;
    }

    const info = extractSimpleBlockInfo(bytes, i);
    if (!info) {
      continue;
    }

    if (info.isVideoLike && info.isKeyframe) {
      return true;
    }
  }

  return false;
}