// Reapply after the mirrored site's runtime hydrates its original markup.
(() => {
  const containers = '.nav-logo, .footer-logo, .nav .brand';
  function updateBrand() {
    document.querySelectorAll(containers).forEach(brand => {
      const image = brand.querySelector('img');
      if (!image) return;
      brand.classList.add('sog-brand');
      if (!image.closest('.sog-cap')) {
        const cap = document.createElement('span');
        cap.className = 'sog-cap';
        cap.setAttribute('aria-hidden', 'true');
        image.before(cap);
        cap.append(image);
        image.alt = '';
      }
      if (image.getAttribute('src') !== '/logo.png') image.src = '/logo.png';
      image.removeAttribute('srcset');
      let wordmark = brand.querySelector('.logo-wordmark, .footer-wordmark, .sog-wordmark');
      if (!wordmark) wordmark = [...brand.children].find(el => el.tagName === 'SPAN' && !el.classList.contains('sog-cap'));
      if (!wordmark) {
        wordmark = document.createElement('span');
        brand.append(wordmark);
      }
      if (!wordmark.classList.contains('sog-wordmark')) {
        wordmark.classList.add('sog-wordmark');
        wordmark.innerHTML = 'School of <span class="green">Gains</span>';
      }
    });
  }
  updateBrand();
  new MutationObserver(updateBrand).observe(document.documentElement, { childList: true, subtree: true });
})();
