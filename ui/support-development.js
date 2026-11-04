const defaultImages = [
  {name: '支付宝', src: '/plugins/siyuan-workbench/images/support-alipay.jpg'},
  {name: '微信', src: '/plugins/siyuan-workbench/images/support-wechat.png'},
];

/** Optional, local-only support images for the plugin settings page. */
export function mountSupportDevelopment(host, {images = defaultImages} = {}) {
  const document = host.ownerDocument;
  const sources = images.map(image => {
    if (typeof image?.name !== 'string' || typeof image.src !== 'string'
      || !image.src.startsWith('/') || image.src.startsWith('//')) {
      throw new Error('支持开发图片必须使用插件内的本地资源路径');
    }
    return {...image};
  });
  const root = document.createElement('section');
  root.className = 'swb-support';
  root.innerHTML = `<details class="swb-support__details">
      <summary>支持开发 / 打赏</summary>
      <p class="swb-support__note">如果这个工作台帮到了你，可以自愿打赏支持后续开发。支持与否均可使用全部功能。</p>
      <div class="swb-support__images"></div>
    </details>
    <p class="swb-support__status" role="status" hidden></p>
    <dialog class="swb-support__dialog" aria-label="查看支持开发二维码">
      <div class="swb-support__preview">
        <header><h3></h3><button type="button" aria-label="关闭二维码预览">关闭</button></header>
        <img class="swb-support__large-image" alt="">
        <footer><a target="_blank" rel="noopener noreferrer">打开原图</a></footer>
      </div>
    </dialog>`;
  host.append(root);
  const details = root.querySelector('details');
  const list = root.querySelector('.swb-support__images');
  const dialog = root.querySelector('dialog');
  const largeImage = dialog.querySelector('img');
  const original = dialog.querySelector('a');
  const closeButton = dialog.querySelector('button');
  const status = root.querySelector('[role="status"]');
  let loaded = false;
  let disposed = false;
  let trigger = null;

  function showStatus(message = '') {
    status.textContent = message;
    status.hidden = !message;
  }

  function showPreview(image, origin) {
    if (disposed) return;
    trigger = origin;
    dialog.querySelector('h3').textContent = image.name + '支持二维码';
    largeImage.alt = image.name + '支持二维码原图';
    largeImage.src = image.src;
    original.href = image.src;
    original.setAttribute('aria-label', '打开' + image.name + '二维码原图');
    showStatus();
    try {
      dialog.showModal();
      closeButton.focus();
    } catch {
      showStatus('预览暂时无法打开，请使用二维码下方的原图链接。');
    }
  }

  function onToggle() {
    if (!details.open || loaded || disposed) return;
    loaded = true;
    for (const source of sources) {
      const card = document.createElement('article');
      card.className = 'swb-support__card';
      const title = document.createElement('h3');
      title.textContent = source.name;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swb-support__image-button';
      button.setAttribute('aria-label', '放大查看' + source.name + '支持二维码');
      const image = document.createElement('img');
      image.alt = source.name + '支持二维码';
      image.decoding = 'async';
      image.src = source.src;
      button.append(image);
      button.addEventListener('click', () => showPreview(source, button));
      const link = document.createElement('a');
      link.href = source.src;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '打开原图';
      link.setAttribute('aria-label', '打开' + source.name + '二维码原图');
      card.append(title, button, link);
      list.append(card);
    }
  }

  function closePreview() {
    if (dialog.open) dialog.close();
  }

  function onPreviewClose() {
    largeImage.removeAttribute('src');
    if (!disposed && trigger?.isConnected) trigger.focus();
  }

  function onDialogClick(event) {
    if (event.target === dialog) closePreview();
  }
  function onPreviewKey(event) {
    if (!dialog.open || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();event.stopImmediatePropagation();
    closePreview();
  }

  function onImageError(event) {
    if (event.target.tagName === 'IMG') showStatus('二维码图片加载失败，请检查插件安装文件后重试。');
  }

  details.addEventListener('toggle', onToggle);
  closeButton.addEventListener('click', closePreview);
  dialog.addEventListener('close', onPreviewClose);
  dialog.addEventListener('click', onDialogClick);
  const keyHost=document.defaultView||dialog;
  keyHost.addEventListener('keydown',onPreviewKey,true);
  root.addEventListener('error', onImageError, true);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      closePreview();
      details.removeEventListener('toggle', onToggle);
      closeButton.removeEventListener('click', closePreview);
      dialog.removeEventListener('close', onPreviewClose);
      dialog.removeEventListener('click', onDialogClick);
      keyHost.removeEventListener('keydown',onPreviewKey,true);
      root.removeEventListener('error', onImageError, true);
      root.remove();
    },
  };
}
