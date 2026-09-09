/* ============================================================
   JUICE WRLD TRIBUTE — interactions
   Progressive enhancement: every section is readable without JS.
   ============================================================ */
(function () {
  'use strict';

  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------
     Album details (keyed by data-album in index.html)
     --------------------------------------------------------- */
  var ART_BASE = 'https://is1-ssl.mzstatic.com/image/thumb/';

  var ALBUMS = {
    ggr: {
      year: '2018',
      title: 'Goodbye & Good Riddance',
      cover: 'cover-a',
      art: ART_BASE + 'Music112/v4/f8/6c/2a/f86c2ae0-b4eb-578c-1f02-3acb8409b815/21UMGIM53733.rgb.jpg/600x600bb.jpg',
      desc: 'His debut, built on guitar loops and sung hooks. This is the record that moved him off SoundCloud.',
      tracks: ['Lucid Dreams', 'All Girls Are the Same', 'Lean Wit Me', 'Betrayal', 'Wasted']
    },
    drfl: {
      year: '2019',
      title: 'Death Race for Love',
      cover: 'cover-b',
      art: ART_BASE + 'Music116/v4/62/10/cf/6210cf4a-be77-3d97-218d-834f68bb33b3/19UMGIM16006.rgb.jpg/600x600bb.jpg',
      desc: 'Twenty-two tracks. It debuted at No. 1 on the Billboard 200, and it is where he pushed furthest from the sound of the first album.',
      tracks: ['Robbery', 'Hear Me Calling', 'Empty', 'Fast', 'Maze']
    },
    lnd: {
      year: '2020',
      title: 'Legends Never Die',
      cover: 'cover-c',
      art: ART_BASE + 'Music114/v4/39/b1/1e/39b11eef-4709-bf53-2b5b-7954d2782496/20UMGIM58296.rgb.jpg/600x600bb.jpg',
      desc: 'The first album released after he died, built from sessions recorded in his last year. It also went to No. 1.',
      tracks: ['Righteous', 'Come & Go', 'Wishing Well', 'Conversations', 'Life’s a Mess']
    },
    fd: {
      year: '2021',
      title: 'Fighting Demons',
      cover: 'cover-d',
      art: ART_BASE + 'Music126/v4/5a/18/b6/5a18b6f3-61cc-2ccc-3d59-874d3a7a2603/21UM1IM54284.rgb.jpg/600x600bb.jpg',
      desc: 'The second posthumous album. It is about what the title says: addiction, and trying to stay ahead of it.',
      tracks: ['Already Dead', 'Burn', 'Wandered to LA', 'Doom', 'Feline']
    },
    tpne: {
      year: '2024',
      title: 'The Party Never Ends',
      cover: 'cover-e',
      art: ART_BASE + 'Music221/v4/f3/21/0d/f3210da8-5344-1e15-0838-65c5e61641f3/24UM1IM10948.rgb.jpg/600x600bb.jpg',
      desc: 'The third posthumous album, released almost five years after he died and still drawn from what he left behind.',
      tracks: ['Lace It', 'AGATS2 (Insecure)', 'Empty Out Your Pockets', 'Misfit', 'Bad Energy']
    }
  };

  /* ---------------------------------------------------------
     Mobile navigation drawer
     --------------------------------------------------------- */
  var nav = document.getElementById('nav');
  var navToggle = document.getElementById('navToggle');
  var navDrawer = document.getElementById('navDrawer');

  function setDrawer(open) {
    navDrawer.hidden = !open;
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.querySelector('.sr-only').textContent =
      open ? 'Close navigation menu' : 'Open navigation menu';
  }

  if (navToggle && navDrawer) {
    navToggle.addEventListener('click', function () {
      setDrawer(navDrawer.hidden);
    });

    navDrawer.addEventListener('click', function (event) {
      if (event.target.closest('a')) setDrawer(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !navDrawer.hidden) {
        setDrawer(false);
        navToggle.focus();
      }
    });
  }

  /* ---------------------------------------------------------
     Nav background on scroll
     --------------------------------------------------------- */
  var scrollTicking = false;
  function onScroll() {
    if (scrollTicking) return;
    scrollTicking = true;
    window.requestAnimationFrame(function () {
      nav.classList.toggle('is-scrolled', window.scrollY > 24);
      scrollTicking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------------------------------------------------
     Scroll spy — highlight the section you're reading
     --------------------------------------------------------- */
  var navAnchors = Array.prototype.slice.call(
    document.querySelectorAll('#navLinks a[href^="#"]')
  );
  var sections = navAnchors
    .map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(Boolean);

  if ('IntersectionObserver' in window && sections.length) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navAnchors.forEach(function (a) {
          if (a.getAttribute('href') === '#' + entry.target.id) {
            a.setAttribute('aria-current', 'true');
          } else {
            a.removeAttribute('aria-current');
          }
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });

    sections.forEach(function (section) { spy.observe(section); });
  }

  /* ---------------------------------------------------------
     Reveal on scroll (skipped entirely for reduced motion)
     --------------------------------------------------------- */
  var revealables = document.querySelectorAll('.reveal');

  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(revealables, function (el) {
      el.classList.add('is-visible');
    });
  } else {
    var revealObserver = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    Array.prototype.forEach.call(revealables, function (el) {
      revealObserver.observe(el);
    });
  }

  /* ---------------------------------------------------------
     Artwork fallback — if the CDN image can't load (offline, blocked),
     hide it and let the generated CSS cover show through instead.
     --------------------------------------------------------- */
  function failCover(img) { img.classList.add('is-failed'); }

  Array.prototype.forEach.call(document.querySelectorAll('.cover-img'), function (img) {
    if (img.complete && img.getAttribute('src') && img.naturalWidth === 0) {
      failCover(img);
    }
    img.addEventListener('error', function () { failCover(img); });
    img.addEventListener('load', function () { img.classList.remove('is-failed'); });
  });

  /* ---------------------------------------------------------
     Album filtering
     --------------------------------------------------------- */
  var filters = document.querySelectorAll('.filter');
  var albumCards = document.querySelectorAll('.album');
  var filterStatus = document.getElementById('filterStatus');

  Array.prototype.forEach.call(filters, function (button) {
    button.addEventListener('click', function () {
      var value = button.dataset.filter;
      var shown = 0;

      Array.prototype.forEach.call(filters, function (other) {
        other.setAttribute('aria-pressed', String(other === button));
      });

      Array.prototype.forEach.call(albumCards, function (card) {
        var match = value === 'all' || card.dataset.era === value;
        card.hidden = !match;
        if (match) shown++;
      });

      if (filterStatus) {
        filterStatus.textContent =
          shown + (shown === 1 ? ' album shown' : ' albums shown');
      }
    });
  });

  /* ---------------------------------------------------------
     Album modal
     --------------------------------------------------------- */
  var modal = document.getElementById('modal');
  var modalPanel = modal ? modal.querySelector('.modal-panel') : null;
  var modalClose = document.getElementById('modalClose');
  var modalCover = document.getElementById('modalCover');
  var modalCoverImg = document.getElementById('modalCoverImg');
  var modalYear = document.getElementById('modalYear');
  var modalTitle = document.getElementById('modalTitle');
  var modalDesc = document.getElementById('modalDesc');
  var modalTracks = document.getElementById('modalTracks');
  var lastFocused = null;

  var COVER_CLASSES = ['cover-a', 'cover-b', 'cover-c', 'cover-d', 'cover-e'];

  function openModal(key) {
    var album = ALBUMS[key];
    if (!album || !modal) return;

    lastFocused = document.activeElement;

    COVER_CLASSES.forEach(function (cls) { modalCover.classList.remove(cls); });
    modalCover.classList.add(album.cover);

    // Swap in the real artwork; the gradient underneath shows if it fails
    modalCoverImg.classList.remove('is-failed');
    modalCoverImg.alt = 'Album cover: ' + album.title + ' by Juice WRLD';
    modalCoverImg.src = album.art;

    modalYear.textContent = album.year;
    modalTitle.textContent = album.title;
    modalDesc.textContent = album.desc;

    modalTracks.textContent = '';
    album.tracks.forEach(function (track, index) {
      var li = document.createElement('li');
      var num = document.createElement('span');
      var name = document.createElement('span');
      num.textContent = String(index + 1).padStart(2, '0');
      name.textContent = track;
      li.appendChild(num);
      li.appendChild(name);
      modalTracks.appendChild(li);
    });

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
  }

  Array.prototype.forEach.call(albumCards, function (card) {
    card.addEventListener('click', function () {
      openModal(card.dataset.album);
    });
  });

  if (modal) {
    modalClose.addEventListener('click', closeModal);

    // Click the backdrop (but not the panel) to dismiss
    modal.addEventListener('click', function (event) {
      if (!modalPanel.contains(event.target)) closeModal();
    });

    document.addEventListener('keydown', function (event) {
      if (modal.hidden) return;

      if (event.key === 'Escape') {
        closeModal();
        return;
      }

      // Keep Tab inside the dialog while it is open
      if (event.key === 'Tab') {
        var focusables = modalPanel.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;

        var first = focusables[0];
        var last = focusables[focusables.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }
})();
