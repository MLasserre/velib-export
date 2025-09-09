// ==UserScript==
// @name         Velib Export (CSV)
// @namespace    https://github.com/MLasserre/velib-export
// @version      1.0.0
// @description  Export your Vélib' ride history to CSV (date, bike type, distance, duration, avg speed, price, CO2)
// @author       MLasserre
// @match        https://www.velib-metropole.fr/private/account*
// @run-at       document-idle
// @license      MIT
// @icon         https://avatars.githubusercontent.com/u/23529678?v=4&s=64
// @grant        none
// @homepageURL  https://github.com/MLasserre/velib-export
// @supportURL   https://github.com/MLasserre/velib-export/issues
// @downloadURL  https://raw.githubusercontent.com/MLasserre/velib-export/main/velib-export.user.js
// @updateURL    https://raw.githubusercontent.com/MLasserre/velib-export/main/velib-export.user.js
// @noframes
// ==/UserScript==


(function () {
  'use strict';
  console.log('[VelibExport] userscript loaded');

  // ------------------------ BEHAVIOR TOGGLES ------------------------
  const DEBUG = false; // verbose logs
  const ONLY_CURRENT_PAGE = false; // scrape only current page (no pagination)
  const NO_DOWNLOAD = false; // preview to console and clipboard instead of downloading
  const MAX_PAGES = 10000; // safety cap against infinite loops

  // ------------------------ ROUTE / DOM HELPERS ------------------------
  /** Return the root container that holds the rides list and pagination. */
  function getRoot() {
    return document.querySelector('.race-tab') || null;
  }

  /** True if the rides view is active (prefer DOM presence). */
  function isRidesView() {
    if (getRoot()) return true;
    if (/^\/account\/rides\b/.test(location.pathname)) return true;
    if (/^\/private\/account\b/.test(location.pathname) && /(^|#)\/my-runs\b/.test(location.hash)) return true;
    return false;
  }

  // ------------------------ NUMBER / TEXT UTILITIES ------------------------
  /** Localized number string -> JS number (handles NBSP + comma decimals, strips units). */
  const toNumber = (s) =>
    parseFloat(String(s || '').replace(/\u00A0/g, ' ').replace(/[^\d,.-]/g, '').replace(',', '.'));

  /** Pad to 2 digits. */
  const pad2 = (n) => String(n).padStart(2, '0');

  /** CSV escape: wrap in quotes, double internal quotes. */
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  /** "DD/MM/YYYY - HH:MM" -> "YYYY-MM-DD HH:MM" (else returns trimmed input). */
  const normalizeDate = (s) => {
    const m = (s || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})/);
    return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : (s || '').trim();
  };

  /** "1h 2min 3sec" | "5min 0sec" | "45sec" -> "HH:MM:SS". */
  const normalizeDuration = (s) => {
    let h = 0, m = 0, sec = 0;
    const H = (s || '').match(/(\d+)\s*h/i); if (H) h = +H[1];
    const M = (s || '').match(/(\d+)\s*min/i); if (M) m = +M[1];
    const S = (s || '').match(/(\d+)\s*sec/i); if (S) sec = +S[1];
    return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  };

  /** Count decimal places in a numeric string ("1,0" -> 1, "14.70" -> 2). */
  function decimalsIn(s) {
    const m = String(s || '').match(/[.,](\d+)/);
    return m ? m[1].length : 0;
  }

  /** Format a number with fixed decimals; returns '' for '', null, or NaN. */
  function formatFixed(num, dec) {
    if (num === '' || num == null || Number.isNaN(Number(num))) return '';
    return Number(num).toFixed(dec);
  }

  // ------------------------ CORE PARSING ------------------------
  /**
   * Parse all .runs blocks inside .race-tab into normalized rows.
   * Row shape:
   *  {
   *    date_operation, bike_number, bike_type,
   *    distance_km, distance_km_str,
   *    duration_hms,
   *    avg_speed_kmh, avg_speed_kmh_str,
   *    price_eur, co2_g
   *  }
   */
  function parseRideBlocks(root = getRoot() || document) {
    const rows = [];
    const blocks = Array.from(root.querySelectorAll('.runs'));

    const inferBikeType = (card) => {
      const icon = card.querySelector('.SUBGROUP1 img[alt], .SUBGROUP1 [aria-label], .SUBGROUP1 [title]');
      const t = (icon?.getAttribute('alt') || icon?.getAttribute('aria-label') || icon?.getAttribute('title') || '').toLowerCase();
      if (/elec|élec|electrique|électrique|assist|e-?bike/.test(t)) return 'electric';
      const cls = icon?.className || '';
      if (/elec|electric/i.test(cls)) return 'electric';
      if (t || cls) return 'regular';
      return '';
    };

    for (const b of blocks) {
      const date_operation = normalizeDate(b.querySelector('.operation-date')?.textContent || '');
      const card = b.querySelector('.row.align-items-center');
      if (!card) continue;

      // Bike number: extract digits only (keeps leading zeros, e.g., "N°03941" -> "03941")
      const bikeNumberText = card.querySelector('.bike-number')?.textContent || '';
      const bike_number = (bikeNumberText.match(/(\d+)/)?.[1]) || '';

      const bike_type = inferBikeType(card);

      // Distance like "1,0km" or "1,3km" (space before "km" may be absent).
      let distance_km = '';
      let distance_dec = 0;
      const distMatch = (card.textContent || '').match(/(\d+(?:[.,]\d+)?)(?=\s*km\b)/i);
      if (distMatch) {
        distance_km = toNumber(distMatch[1]);
        distance_dec = decimalsIn(distMatch[1]);
      }

      // Duration
      const durTxt = card.querySelector('.duration')?.textContent || '';
      const duration_hms = durTxt
        ? normalizeDuration(durTxt)
        : normalizeDuration(((card.textContent || '').match(/((?:\d+\s*h\s*)?(?:\d+\s*min\s*)?(?:\d+\s*sec)?)/i) || [])[1] || '');

      // Average speed "16 km/h" or "19.6 km/h"
      let avg_speed_kmh = NaN;
      let speed_dec = 0;
      const speedTxt = card.querySelector('.speed')?.textContent || '';
      if (speedTxt) {
        avg_speed_kmh = toNumber(speedTxt);
        speed_dec = decimalsIn(speedTxt);
      } else {
        const sm = (card.textContent || '').match(/(\d+(?:[.,]\d+)?)(?=\s*km\/h)/i);
        if (sm) {
          avg_speed_kmh = toNumber(sm[1]);
          speed_dec = decimalsIn(sm[1]);
        }
      }

      // Price (e.g., "0 €")
      let price_eur = 0;
      const priceSpan = Array.from(card.querySelectorAll('.SUBGROUP2 span, .SUBGROUP2 .text-center span'))
        .find((e) => /€/.test(e.textContent || ''));
      if (priceSpan) price_eur = toNumber(priceSpan.textContent);

      // CO2 saved: may be shown in g or kg; normalize to grams
      let co2_g = '';
      const co2Text = b.querySelector('.eco-details-small .negative-margin')?.textContent || '';
      if (co2Text) {
        const m = co2Text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
        if (m) {
          const val = toNumber(m[1]);
          const unit = m[2].toLowerCase();
          co2_g = unit === 'kg' ? val * 1000 : val;
        }
      }

      if (distance_km !== '' || duration_hms !== '') {
        rows.push({
          date_operation,
          bike_number,
          bike_type,
          distance_km,
          distance_km_str: distance_km === '' ? '' :
            (distance_dec ? formatFixed(distance_km, distance_dec) : String(distance_km)),
          duration_hms,
          avg_speed_kmh,
          avg_speed_kmh_str: Number.isNaN(avg_speed_kmh) ? '' :
            (speed_dec ? formatFixed(avg_speed_kmh, speed_dec) : String(avg_speed_kmh)),
          price_eur,
          co2_g
        });
      }
    }

    if (DEBUG) {
      console.log('[VelibExport] parsed rows:', rows.length);
      if (rows.length) console.table(rows.slice(0, 5));
    }
    return rows;
  }

  // ------------------------ PAGINATION (event-driven) ------------------------
  /** Return the pagination <ul> element within the rides root. */
  function getPagination() {
    const root = getRoot();
    return root ? root.querySelector('ngb-pagination ul.pagination') : null;
  }

  /** Read the active page number from the pagination (0 if not found). */
  function getActivePageNumber() {
    const pag = getPagination();
    const active = pag?.querySelector('li.page-item.active a.page-link');
    const n = parseInt(active?.textContent?.trim() || '', 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** Click the "Next" control or the next numbered page after the active one. */
  function clickNextPage() {
    const pag = getPagination();
    if (!pag) return false;

    // Prefer explicit Next
    const nextControl = pag.querySelector('li.page-item:not(.disabled) a.page-link[aria-label="Next"]');
    if (nextControl) {
      try { nextControl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
      catch { nextControl.click(); }
      return true;
    }

    // Fallback: next numbered page
    const activeLi = pag.querySelector('li.page-item.active');
    if (!activeLi) return false;
    let li = activeLi.nextElementSibling;
    while (li && (li.classList.contains('disabled') || !li.querySelector('a.page-link'))) {
      li = li.nextElementSibling;
    }
    const link = li?.querySelector('a.page-link');
    if (!link) return false;
    try { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
    catch { link.click(); }
    return true;
  }

  /** Click the "First" control or the numbered page "1" if available. */
  function clickFirstPage() {
    const pag = getPagination();
    if (!pag) return false;

    // Explicit "First" (enabled)
    const firstControl = pag.querySelector('li.page-item:not(.disabled) a.page-link[aria-label="First"]');
    if (firstControl) {
      try { firstControl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
      catch { firstControl.click(); }
      return true;
    }

    // Fallback: the numbered page "1" (if not already active)
    const firstNum = Array.from(pag.querySelectorAll('li.page-item a.page-link'))
      .find(a => (a.textContent || '').trim() === '1');
    if (firstNum && !firstNum.closest('li')?.classList.contains('active')) {
      try { firstNum.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
      catch { firstNum.click(); }
      return true;
    }

    return false;
  }

  /**
   * Wait until the rides list refreshes OR the active page number changes.
   * Resolves faster than any fixed delay; times out as a safety.
   */
  function waitForRidesRefresh(prevPage, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const root = getRoot();
      if (!root) return resolve(false);

      const start = Date.now();

      const changed = () => {
        // Condition 1: active page advanced/changed
        const nowPage = getActivePageNumber();
        if (nowPage && nowPage !== prevPage) return true;

        // Condition 2: first ride sentinel changed (covers cases without numbered pages)
        const firstRuns = root.querySelector('.runs .bike-number, .runs .operation-date');
        const sig = firstRuns ? firstRuns.textContent?.trim() : '';
        if (sig && sig !== waitForRidesRefresh.__lastSig) {
          waitForRidesRefresh.__lastSig = sig;
          return true;
        }
        return false;
      };

      // Init sentinel
      const first = root.querySelector('.runs .bike-number, .runs .operation-date');
      waitForRidesRefresh.__lastSig = first ? first.textContent?.trim() : '';

      // Fast micro-polls to catch very quick updates without installing MO
      let polls = 0;
      const microPoll = () => {
        if (changed()) return resolve(true);
        if (polls++ < 5) return queueMicrotask(microPoll);

        // Fallback: observe DOM mutations for structural changes
        const mo = new MutationObserver(() => {
          if (changed()) {
            try { mo.disconnect(); } catch {}
            resolve(true);
          }
        });
        mo.observe(root, { childList: true, subtree: true });

        // Safety timeout
        const left = Math.max(0, timeoutMs - (Date.now() - start));
        setTimeout(() => { try { mo.disconnect(); } catch {} resolve(false); }, left);
      };
      microPoll();
    });
  }

  // ------------------------ CSV BUILD / DOWNLOAD ------------------------
  function buildCsv(rows) {
    const headers = [
      'date_operation',
      'bike_number',
      'bike_type',
      'distance_km',
      'duration_hms',
      'avg_speed_kmh',
      'price_eur',
      'co2_g'
    ];

    const getField = (r, h) => {
      if (h === 'distance_km') return r.distance_km_str ?? r.distance_km;
      if (h === 'avg_speed_kmh') return r.avg_speed_kmh_str ?? r.avg_speed_kmh;
      return r[h];
    };

    const lines = [headers.join(',')].concat(
      rows.map((r) => headers.map((h) => csvEscape(getField(r, h))).join(','))
    );
    return lines.join('\n');
  }

  function triggerDownload(csv, filename = 'velib_rides.csv') {
    if (NO_DOWNLOAD) {
      console.log('[VelibExport] CSV preview:\n' + csv.split('\n').slice(0, 12).join('\n'));
      try { navigator.clipboard.writeText(csv); console.log('[VelibExport] CSV copied to clipboard'); } catch {}
      return;
    }
    try {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
    } catch (e) {
      console.warn('[VelibExport] download failed, dumping CSV to console:', e);
      console.log(csv);
      alert('Could not trigger a download. CSV printed to console.');
    }
  }

  // ------------------------ ORCHESTRATOR ------------------------
  /**
   * End-to-end export:
   *  - Ensure rides view and root container exist.
   *  - If not on page 1, jump to first page and wait for refresh.
   *  - Loop pages: yield a frame, parse .runs, move to next page.
   *  - Deduplicate via a composite key (includes bike_number).
   *  - Build and download CSV.
   * Pagination waits for real DOM refresh instead of sleeping.
   */
  async function runExport() {
    if (!isRidesView() || !getRoot()) {
      alert('Open the rides view first: /private/account#/my-runs (or /account/rides)');
      return;
    }

    // Normalize starting point: go to page 1 if we are not already there
    const startPage = getActivePageNumber();
    if (startPage && startPage !== 1) {
      const movedToFirst = clickFirstPage();
      if (movedToFirst) {
        await waitForRidesRefresh(startPage, 8000);
      }
    }

    const seen = new Set();
    const all = [];
    let pageCount = 0;

    while (true) {
      if (MAX_PAGES && pageCount >= MAX_PAGES) {
        if (DEBUG) console.warn('[VelibExport] MAX_PAGES reached, stopping.');
        break;
      }

      // Keep the UI responsive; do not move the viewport.
      await new Promise(requestAnimationFrame);

      pageCount++;
      if (DEBUG) console.time(`page_${pageCount}`);

      // Parse current page
      const rows = parseRideBlocks();
      for (const r of rows) {
        const key = [r.date_operation, r.bike_number, r.distance_km, r.duration_hms, r.price_eur].join('|');
        if (!seen.has(key)) { seen.add(key); all.push(r); }
      }
      if (DEBUG) console.log(`[VelibExport] page ${pageCount}: +${rows.length} (total ${all.length})`);

      // Stop after first page if requested
      if (ONLY_CURRENT_PAGE) break;

      // Click next and wait for actual refresh (event-driven)
      const before = getActivePageNumber();
      const moved = clickNextPage();
      if (!moved) break;

      const refreshed = await waitForRidesRefresh(before, 7000);
      if (!refreshed) {
        if (DEBUG) console.warn('[VelibExport] pagination did not refresh in time, stopping.');
        break;
      }

      if (DEBUG) console.timeEnd(`page_${pageCount}`);
    }

    const csv = buildCsv(all);
    triggerDownload(csv);
    if (DEBUG) console.log(`✅ Done: ${all.length} rides exported`);
  }

  // ------------------------ UI & SPA HOOKS ------------------------
  function injectButton() {
    if (!isRidesView()) return;
    if (document.getElementById('velib-export-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'velib-export-btn';
    btn.textContent = 'Export rides (CSV)';
    Object.assign(btn.style, {
      position: 'fixed',
      zIndex: 999999,
      top: '12px',
      right: '12px',
      padding: '8px 12px',
      borderRadius: '8px',
      border: '1px solid #ccc',
      background: '#fff',
      cursor: 'pointer',
      boxShadow: '0 2px 6px rgba(0,0,0,0.15)'
    });
    btn.addEventListener('click', runExport);
    document.body.appendChild(btn);
    if (DEBUG) console.log('[VelibExport] button injected');
  }

  function ensureButton() {
    if (isRidesView()) injectButton();
  }

  window.addEventListener('load', ensureButton);
  window.addEventListener('hashchange', ensureButton);
  window.addEventListener('popstate', ensureButton);
  new MutationObserver(() => ensureButton()).observe(document, { childList: true, subtree: true });

  // Expose a small API for console testing
  window.velibExport = {
    runExport,
    parseRideBlocks,
    getActivePageNumber,
    clickNextPage,
    buildCsv
  };
})();