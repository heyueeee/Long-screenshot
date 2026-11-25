/* Long Shot — clipboard helper, shared by the popup and the viewer page.
 * Clipboard writes have to happen in a page (the offscreen document and the
 * service worker have no user activation), and Chrome only accepts PNG bitmaps,
 * so a JPEG result is re-encoded first.
 */

async function pngBlobOf(part) {
  const blob = await fetch(part.url).then((res) => res.blob());
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('浏览器没能把 JPEG 转成剪贴板需要的 PNG，请改用 PNG 格式重截');
  return png;
}

/** Only the PNG path passes a pending promise: that keeps the click's activation
 *  alive while a 30-screen image is still being fetched. */
async function copyShot(shot) {
  if (!shot || !shot.parts || !shot.parts.length) throw new Error('没有可复制的结果');
  const part = shot.parts[0];
  const value = part.type === 'image/png' ? fetch(part.url).then((res) => res.blob()) : await pngBlobOf(part);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': value })]);
  return shot.parts.length > 1
    ? `已复制第 1 / ${shot.parts.length} 段，其余各段请用已保存的文件粘贴`
    : '已复制到剪贴板，可直接粘贴到聊天窗口或文档';
}
