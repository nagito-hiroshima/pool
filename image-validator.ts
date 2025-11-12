// 画像ファイル判定ユーティリティ（サーバー/Worker 環境向け）
export const allowedExtensions = ["jpg","jpeg","png","gif","webp","svg","bmp","heic","heif","tiff"];

export const isImageByExt = (name?: string) => {
  if (!name) return false;
  const m = name.split(".").pop() || "";
  return allowedExtensions.includes(m.toLowerCase());
};

export const isImageByMime = (mime?: string) => {
  if (!mime) return false;
  return mime === "image/svg+xml" || mime.startsWith("image/");
};

// マジックバイトによる判定（先頭数バイトを見て判定）
export const isImageBuffer = (bytes: Uint8Array) => {
  if (!bytes || bytes.length < 4) return false;
  const s = (i:number, n:number) => String.fromCharCode(...Array.from(bytes.slice(i, i+n)));
  // JPEG
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
  // PNG
  if (bytes[0] === 0x89 && s(1,3) === "PNG") return true;
  // GIF87a / GIF89a
  if (s(0,6) === "GIF87a" || s(0,6) === "GIF89a") return true;
  // BMP ("BM")
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return true;
  // WebP: "RIFF....WEBP"
  if (s(0,4) === "RIFF" && s(8,4) === "WEBP") return true;
  // SVG (テキストなので先頭に '<' と svg 要素を含むか)
  if (bytes[0] === 0x3C) {
    const txt = new TextDecoder().decode(bytes).toLowerCase();
    if (txt.includes("<svg")) return true;
  }
  // HEIC/HEIF: ftyp box に heic/heix/hevc/heif/mif1 等が含まれる
  if (bytes.length >= 12 && s(4,4) === "ftyp") {
    const brand = s(8,4);
    if (["heic","heix","hevc","hevx","mif1","msf1","heif"].includes(brand)) return true;
  }
  return false;
};

// File (ブラウザ/Worker の File) を効率的に検査するラッパー
export const validateFileIsImage = async (file: File): Promise<boolean> => {
  if (!file) return false;
  if (isImageByMime(file.type)) return true;
  if (isImageByExt(file.name)) return true;
  // 先頭数KBのみ読み込んで判定（重いファイルを全読みしない）
  const probeSize = Math.min(4096, file.size || 4096);
  const slice = ("slice" in file) ? (file as any).slice(0, probeSize) : file;
  const ab = await slice.arrayBuffer();
  const bytes = new Uint8Array(ab);
  return isImageBuffer(bytes);
};