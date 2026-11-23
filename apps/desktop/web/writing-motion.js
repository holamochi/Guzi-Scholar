(() => {
  'use strict';

  const editorSelector = [
    '#notes-editor', '.annotation-note-editor', '#chat-input', 'textarea.paper-report-editor',
    '#library-search', '#graph-search', '#reader-search-input', '#zotero-search',
    '#view-name', '[data-filter-value]', 'input.cell-editor-input',
    '#editor-folder-name', '#editor-value', '#chat-session-title-input',
    '[data-metadata-field]:not([data-metadata-field="year"])',
  ].join(', ');
  const controllers = new WeakMap();
  const pasteHighlight = 'writing-motion-paste';
  const easing = 'cubic-bezier(.22, 1, .36, 1)';
  const styles = `
    @property --writing-motion-paste-opacity {
      syntax: '<percentage>';
      inherits: true;
      initial-value: 100%;
    }
    @property --writing-motion-selection-strength {
      syntax: '<percentage>';
      inherits: true;
      initial-value: 24%;
    }
    .writing-motion-caret-active:focus { caret-color: transparent !important; }
    .writing-motion-overlay {
      position: fixed; inset: 0; z-index: 142; overflow: hidden; pointer-events: none;
    }
    dialog > .writing-motion-overlay { position: absolute; }
    .writing-motion-caret {
      position: absolute; top: 0; left: 0; z-index: 2; width: 1.75px;
      border-radius: 1px; pointer-events: none;
    }
    .writing-motion-caret:not([data-moving]) { animation: writing-motion-blink 1060ms step-end infinite 500ms; }
    @keyframes writing-motion-blink { 50% { opacity: 0; } }
    .writing-motion-layer {
      position: absolute; inset: 0; overflow: hidden; pointer-events: none;
    }
    .writing-motion-copy, .writing-motion-paste-mark {
      position: absolute; border-radius: 2px;
      background: color-mix(in srgb, var(--writing-motion-accent) 26%, transparent);
    }
    .writing-motion-copy {
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--writing-motion-accent) 52%, transparent);
    }
    .writing-motion-mirror {
      position: fixed; visibility: hidden; pointer-events: none;
      box-sizing: border-box; overflow: hidden; margin: 0;
    }
    [data-writing-motion-selection]::selection, [data-writing-motion-selection] ::selection {
      background-color: color-mix(in srgb, var(--writing-motion-accent, var(--accent, #447ac1)) var(--writing-motion-selection-strength), transparent);
    }
  `;
  const clipsContent = /^(auto|scroll|hidden|clip)$/u;

  function isTextControl(editor) {
    return editor?.tagName === 'TEXTAREA'
      || (editor?.tagName === 'INPUT' && (editor.type === 'text' || editor.type === 'search'));
  }

  function visibleBounds(editor, editorBounds = editor.getBoundingClientRect()) {
    const doc = editor.ownerDocument;
    const view = doc.defaultView;
    const clip = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
    for (let node = editor; node && node !== doc.body; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      const clipX = node === editor || clipsContent.test(style.overflowX);
      const clipY = node === editor || clipsContent.test(style.overflowY);
      if (!clipX && !clipY) continue;
      const bounds = node === editor ? editorBounds : node.getBoundingClientRect();
      if (clipX) {
        const left = bounds.left + node.clientLeft;
        clip.left = Math.max(clip.left, left);
        clip.right = Math.min(clip.right, left + node.clientWidth);
      }
      if (clipY) {
        const top = bounds.top + node.clientTop;
        clip.top = Math.max(clip.top, top);
        clip.bottom = Math.min(clip.bottom, top + node.clientHeight);
      }
    }
    return clip;
  }

  function createController(doc) {
    const view = doc.defaultView;
    const motion = view.matchMedia('(any-pointer: fine) and (prefers-reduced-motion: no-preference) and (forced-colors: none)');
    const fallbackAccent = '#447ac1';
    const stylesheet = doc.createElement('style');
    stylesheet.textContent = styles;
    const pasteStyles = doc.createElement('style');
    doc.head.append(stylesheet, pasteStyles);

    const caret = doc.createElement('div');
    caret.className = 'writing-motion-caret';
    caret.hidden = true;
    const clipboardLayer = doc.createElement('div');
    clipboardLayer.className = 'writing-motion-layer';
    const overlay = doc.createElement('div');
    overlay.className = 'writing-motion-overlay';
    overlay.append(caret, clipboardLayer);
    const mirror = doc.createElement('div');
    mirror.className = 'writing-motion-mirror';
    for (const node of [overlay, mirror]) node.setAttribute('aria-hidden', 'true');
    doc.body.append(overlay, mirror);

    let composing = null;
    let committedComposition = null;
    let observedEditor = null;
    let caretEditor = null;
    let selectedEditor = null;
    let selectionAnimation = null;
    let pasteAnimation = null;
    let pasteHighlights = [];
    let nativePaste = null;
    let current = null;
    let target = null;
    let frame = 0;
    let previousTime = null;
    let measure = false;
    let snap = false;
    const sizeObserver = new view.ResizeObserver(() => {
      if (observedEditor && !canAnimate(observedEditor)) reset();
      else schedule();
    });

    function canAnimate(editor) {
      if (!motion.matches || !doc.hasFocus() || doc.hidden || !editor?.matches(editorSelector)
        || editor !== doc.activeElement || editor.closest('[hidden], [inert], [aria-hidden="true"], .is-closing')
        || !(editor.isContentEditable || (isTextControl(editor) && !editor.readOnly && !editor.disabled))
        || !editor.getClientRects().length) return false;
      const dialog = editor.closest('dialog');
      // The form mirror uses unscaled font metrics. Keep the native caret
      // through a dialog's scale transition, then align to its settled box.
      return !dialog || (dialog.open && Math.abs(dialog.getBoundingClientRect().width - dialog.offsetWidth) < 1);
    }

    function overlayOrigin(editor) {
      const host = editor.closest('dialog[open]') || doc.body;
      if (overlay.parentNode !== host) host.append(overlay);
      return host === doc.body ? { left: 0, top: 0 } : overlay.getBoundingClientRect();
    }

    function accent(editor) {
      const style = view.getComputedStyle(editor);
      return style.getPropertyValue('--annotation-color').trim()
        || style.getPropertyValue('--accent').trim() || fallbackAccent;
    }

    function textControlRange(editor, start = editor.selectionStart, end = editor.selectionEnd) {
      const bounds = editor.getBoundingClientRect();
      const style = view.getComputedStyle(editor);
      const singleLine = editor.tagName === 'INPUT';
      for (const property of [
        'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontStretch', 'fontVariant',
        'fontKerning', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textIndent',
        'textTransform', 'direction', 'tabSize', 'wordBreak', 'overflowWrap',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      ]) mirror.style[property] = style[property];
      mirror.style.left = (bounds.left + editor.clientLeft) + 'px';
      mirror.style.top = (bounds.top + editor.clientTop) + 'px';
      mirror.style.width = editor.clientWidth + 'px';
      mirror.style.height = editor.clientHeight + 'px';
      mirror.style.whiteSpace = singleLine || editor.wrap === 'off' ? 'pre' : 'pre-wrap';
      mirror.style.alignContent = singleLine ? 'center' : 'normal';
      const value = editor.value + '\u200b';
      if (mirror.textContent !== value) mirror.textContent = value;
      mirror.scrollTop = editor.scrollTop;
      mirror.scrollLeft = editor.scrollLeft;
      const range = doc.createRange();
      range.setStart(mirror.firstChild, start);
      range.setEnd(mirror.firstChild, end);
      return range;
    }

    function selectionRange(editor) {
      if (isTextControl(editor)) return textControlRange(editor);
      const selection = doc.getSelection();
      if (!selection?.rangeCount) return null;
      const range = selection.getRangeAt(0);
      return editor.contains(range.commonAncestorContainer) ? range : null;
    }

    function caretRect(range) {
      const rect = range.getClientRects()[0];
      const node = range.startContainer;
      if (rect?.height || node.nodeType !== view.Node.ELEMENT_NODE) return rect;

      // Chromium can report no rectangle for a caret on an element boundary,
      // including the position after a text node inserted by the paste handler.
      const previous = node.childNodes[range.startOffset - 1];
      const next = node.childNodes[range.startOffset];
      const textEdge = (child, atEnd) => {
        while (child?.nodeType === view.Node.ELEMENT_NODE && child.isContentEditable
          && view.getComputedStyle(child).display === 'inline') {
          child = atEnd ? child.lastChild : child.firstChild;
        }
        return child?.nodeType === view.Node.TEXT_NODE ? child : null;
      };
      const edge = doc.createRange();
      const before = textEdge(previous, true);
      const after = textEdge(next, false);
      if (before) edge.setStart(before, before.length);
      else if (after) edge.setStart(after, 0);
      else if (next?.nodeName === 'BR') {
        edge.selectNode(next);
        return edge.getClientRects()[0];
      } else return rect;
      edge.collapse(true);
      return edge.getClientRects()[0];
    }

    function caretPosition(editor, range, rect = caretRect(range)) {
      const node = range.startContainer;
      const element = node.nodeType === view.Node.ELEMENT_NODE ? node : node.parentElement;
      if (element?.closest('pre, [contenteditable="false"]')) return null;
      if (!rect?.height) return null;
      const editorBounds = editor.getBoundingClientRect();
      const clip = visibleBounds(editor, editorBounds);
      const top = Math.max(rect.top, clip.top);
      const bottom = Math.min(rect.bottom, clip.bottom);
      if (bottom <= top || rect.left < clip.left - 1 || rect.left > clip.right + 1) return null;
      return {
        x: Math.max(clip.left, Math.min(rect.left, clip.right - 1.75)),
        y: top,
        height: bottom - top,
        editorLeft: editorBounds.left,
        editorTop: editorBounds.top,
      };
    }

    function preeditPosition(editor, range) {
      if (!range?.collapsed || range.startContainer.nodeType !== view.Node.TEXT_NODE) return null;
      const rects = range.getClientRects();
      return rects.length === 1 && rects[0].width <= 1 ? caretPosition(editor, range, rects[0]) : null;
    }

    function paintedPoint(editor) {
      return caretEditor === editor && current && target
        ? { ...current, editorLeft: target.editorLeft, editorTop: target.editorTop }
        : null;
    }

    function clearCaret() {
      caretEditor?.classList.remove('writing-motion-caret-active');
      caretEditor = null;
      caret.hidden = true;
      caret.removeAttribute('data-moving');
      current = target = null;
      previousTime = null;
    }

    function clearSelection() {
      selectionAnimation?.cancel();
      selectionAnimation = null;
      selectedEditor?.removeAttribute('data-writing-motion-selection');
      selectedEditor?.style.removeProperty('--writing-motion-accent');
      selectedEditor = null;
    }

    function clearPaste() {
      if (!pasteAnimation) return;
      pasteAnimation.onfinish = null;
      pasteAnimation.cancel();
      pasteAnimation = null;
      for (const name of pasteHighlights) view.CSS.highlights.delete(name);
      pasteHighlights = [];
      pasteStyles.textContent = '';
    }

    function reset() {
      view.cancelAnimationFrame(frame);
      frame = 0;
      measure = snap = false;
      nativePaste = null;
      committedComposition = null;
      if (composing) composing.point = null;
      clearCaret();
      clearSelection();
      clearPaste();
      sizeObserver.disconnect();
      observedEditor = null;
      clipboardLayer.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
      clipboardLayer.replaceChildren();
      if (overlay.parentNode !== doc.body) doc.body.append(overlay);
      mirror.textContent = '';
    }

    function fadeSelection(editor) {
      if (selectedEditor === editor) return;
      clearSelection();
      selectedEditor = editor;
      editor.dataset.writingMotionSelection = '';
      editor.style.setProperty('--writing-motion-accent', accent(editor));
      selectionAnimation = editor.animate([
        { '--writing-motion-selection-strength': '11%' },
        { '--writing-motion-selection-strength': '24%' },
      ], { duration: 170, easing, fill: 'both' });
    }

    function updateCaret() {
      const editor = doc.activeElement;
      const active = canAnimate(editor) ? editor : null;
      if (active !== observedEditor) {
        sizeObserver.disconnect();
        observedEditor = active;
        if (active) sizeObserver.observe(active);
      }
      const range = active ? selectionRange(active) : null;
      const preedit = composing?.editor === active ? composing : null;
      if (range && !range.collapsed && !preedit) fadeSelection(editor);
      else clearSelection();
      const point = preedit ? preeditPosition(editor, range) : range?.collapsed ? caretPosition(editor, range) : null;
      const preeditOrigin = preedit?.point;
      if (preedit) {
        preedit.point = point;
        const dx = point && preeditOrigin ? (point.x - point.editorLeft) - (preeditOrigin.x - preeditOrigin.editorLeft) : 0;
        const dy = point && preeditOrigin ? (point.y - point.editorTop) - (preeditOrigin.y - preeditOrigin.editorTop) : 0;
        if (!point || !preeditOrigin || (!caretEditor && Math.hypot(dx, dy) < 0.5)) { clearCaret(); return; }
      }
      const compositionOrigin = committedComposition?.editor === active ? committedComposition.origin : null;
      committedComposition = null;
      if (!point) { clearCaret(); return; }
      if (caretEditor !== editor) {
        clearCaret();
        caretEditor = editor;
        const style = view.getComputedStyle(editor);
        caret.style.backgroundColor = style.caretColor === 'auto' ? style.color : style.caretColor;
        editor.classList.add('writing-motion-caret-active');
        caret.hidden = false;
      }
      current ??= preeditOrigin || compositionOrigin || point;
      const previous = target || preeditOrigin || compositionOrigin;
      if (previous && (point.editorLeft !== previous.editorLeft || point.editorTop !== previous.editorTop)) {
        current = {
          x: current.x + point.editorLeft - previous.editorLeft,
          y: current.y + point.editorTop - previous.editorTop,
          height: current.height,
        };
      }
      if (snap || Math.hypot(current.x - point.x, current.y - point.y) > 640) current = point;
      target = point;
    }

    function draw(now) {
      frame = 0;
      if (measure) updateCaret();
      measure = snap = false;
      if (!target) return;
      const distance = Math.max(
        Math.abs(target.x - current.x), Math.abs(target.y - current.y), Math.abs(target.height - current.height),
      );
      const moving = distance > 0.2;
      if (moving) {
        const elapsed = previousTime === null ? 0 : Math.min(now - previousTime, 24);
        previousTime = now;
        const progress = 1 - Math.exp(-elapsed / 36);
        current = {
          x: current.x + (target.x - current.x) * progress,
          y: current.y + (target.y - current.y) * progress,
          height: current.height + (target.height - current.height) * progress,
        };
        frame = view.requestAnimationFrame(draw);
      } else {
        current = target;
        previousTime = null;
        // During marked text the real caret handles any IME movement we
        // cannot observe between browser selection updates.
        if (composing?.editor === caretEditor) { clearCaret(); return; }
      }
      const origin = overlayOrigin(caretEditor);
      caret.style.transform = 'translate3d(' + (current.x - origin.left) + 'px, ' + (current.y - origin.top) + 'px, 0)';
      caret.style.height = current.height + 'px';
      caret.toggleAttribute('data-moving', moving);
    }

    function schedule({ instant = false } = {}) {
      if (!caretEditor && !selectedEditor && !canAnimate(doc.activeElement)) return;
      measure = true;
      snap ||= instant;
      if (!frame) frame = view.requestAnimationFrame(draw);
    }

    function flashClipboard(editor, range, kind) {
      const clip = visibleBounds(editor);
      const origin = overlayOrigin(editor);
      clipboardLayer.replaceChildren();
      clipboardLayer.style.setProperty('--writing-motion-accent', accent(editor));
      let count = 0;
      for (const rect of range.getClientRects()) {
        const left = Math.max(clip.left, rect.left);
        const top = Math.max(clip.top, rect.top);
        const width = Math.min(clip.right, rect.right) - left;
        const height = Math.min(clip.bottom, rect.bottom) - top;
        if (width <= 0 || height <= 0) continue;
        const mark = doc.createElement('div');
        mark.className = kind === 'copy' ? 'writing-motion-copy' : 'writing-motion-paste-mark';
        Object.assign(mark.style, {
          left: (left - origin.left) + 'px', top: (top - origin.top) + 'px',
          width: width + 'px', height: height + 'px',
        });
        clipboardLayer.append(mark);
        const flash = mark.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: kind === 'copy' ? 170 : 240, easing });
        flash.onfinish = () => mark.remove();
        if (++count === 80) break;
      }
    }

    function highlightPastedText(editor, range) {
      const ink = view.getComputedStyle(editor).color;
      const root = range.commonAncestorContainer;
      const walker = doc.createTreeWalker(root, view.NodeFilter.SHOW_TEXT);
      const colors = new Map();
      for (let text = root.nodeType === view.Node.TEXT_NODE ? root : walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.length || !range.intersectsNode(text)) continue;
        const color = view.getComputedStyle(text.parentElement).color;
        if (color === ink) continue;
        const start = range.startContainer === text ? range.startOffset : 0;
        const end = range.endContainer === text ? range.endOffset : text.length;
        if (end <= start) continue;
        const part = doc.createRange();
        part.setStart(text, start);
        part.setEnd(text, end);
        if (!colors.has(color)) colors.set(color, []);
        colors.get(color).push(part);
      }
      const rules = [];
      const addHighlight = (name, color, ranges, priority) => {
        const highlight = new view.Highlight(...ranges);
        highlight.priority = priority;
        view.CSS.highlights.set(name, highlight);
        pasteHighlights.push(name);
        rules.push('::highlight(' + name + ') { color: color-mix(in srgb, ' + color
          + ' var(--writing-motion-paste-opacity), transparent); }');
      };
      // A separate highlight for colored text preserves its ink while fading.
      addHighlight(pasteHighlight, ink, [range.cloneRange()], 0);
      for (const [color, parts] of colors) {
        addHighlight(pasteHighlight + '-' + pasteHighlights.length, color, parts, 1);
      }
      pasteStyles.textContent = rules.join('\n');
    }

    function revealPaste(editor, range) {
      if (!canAnimate(editor) || composing?.editor === editor || range.collapsed) return;
      clearPaste();
      const highlights = view.CSS?.highlights;
      if (highlights && !isTextControl(editor)) {
        highlightPastedText(editor, range);
        pasteAnimation = editor.animate([
          { '--writing-motion-paste-opacity': '24%' },
          { '--writing-motion-paste-opacity': '100%' },
        ], { duration: 240, easing, fill: 'both' });
        pasteAnimation.onfinish = clearPaste;
      } else {
        flashClipboard(editor, range, 'paste');
      }
      schedule();
    }

    function revealImage(editor, image) {
      if (!canAnimate(editor) || composing?.editor === editor) return;
      clearPaste();
      pasteAnimation = image.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 240, easing });
      pasteAnimation.onfinish = clearPaste;
    }

    function layoutChanged(event) {
      if (event.type === 'scroll' && event.target !== doc && !event.target.contains(doc.activeElement)) return;
      if (composing) { composing.point = null; clearCaret(); }
      clipboardLayer.replaceChildren();
      schedule({ instant: true });
    }
    function containerMotionFinished(event) {
      if (event.target.contains(doc.activeElement)) schedule();
    }
    doc.addEventListener('focusin', () => schedule({ instant: true }));
    doc.addEventListener('focusout', (event) => {
      if (!event.target.matches(editorSelector)) return;
      composing = null;
      reset();
    });
    doc.addEventListener('selectionchange', () => schedule(), true);
    doc.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.(editorSelector)) {
        clearCaret();
        clearSelection();
        schedule({ instant: true });
      }
    }, true);
    doc.addEventListener('compositionstart', (event) => {
      const editor = event.target;
      if (!editor.matches(editorSelector)) return;
      const range = canAnimate(editor) ? selectionRange(editor)?.cloneRange() : null;
      range?.collapse(true);
      const point = paintedPoint(editor) || (range && caretPosition(editor, range));
      reset();
      composing = { editor, point };
    });
    doc.addEventListener('compositionupdate', (event) => {
      if (event.target === composing?.editor) schedule();
    });
    doc.addEventListener('compositionend', (event) => {
      if (event.target !== composing?.editor) return;
      const editor = composing.editor;
      const origin = paintedPoint(editor) || composing.point;
      if (event.data && origin) committedComposition = { editor, origin };
      composing = null;
      previousTime = null;
      schedule({ instant: !committedComposition });
    });
    doc.addEventListener('beforeinput', (event) => {
      const editor = event.target;
      if (!editor.matches(editorSelector)) return;
      clearPaste();
      if (event.inputType === 'insertFromPaste' && isTextControl(editor) && canAnimate(editor)) {
        nativePaste = { editor, start: editor.selectionStart };
      }
    }, true);
    doc.addEventListener('input', (event) => {
      const editor = event.target;
      if (!editor.matches(editorSelector)) return;
      if (event.isComposing) { schedule(); return; }
      if (nativePaste?.editor === editor) {
        if (event.inputType === 'insertFromPaste' && editor.selectionEnd > nativePaste.start && canAnimate(editor)) {
          revealPaste(editor, textControlRange(editor, nativePaste.start, editor.selectionEnd));
        }
        nativePaste = null;
      }
      schedule();
    });
    doc.addEventListener('keyup', (event) => { if (event.target.matches(editorSelector)) schedule(); });
    doc.addEventListener('copy', (event) => {
      const editor = event.target.closest?.(editorSelector);
      if (!canAnimate(editor) || composing?.editor === editor) return;
      const range = selectionRange(editor);
      if (range && !range.collapsed) flashClipboard(editor, range, 'copy');
    });
    doc.addEventListener('scroll', layoutChanged, { capture: true, passive: true });
    doc.addEventListener('animationend', containerMotionFinished);
    doc.addEventListener('transitionend', containerMotionFinished);
    view.addEventListener('resize', layoutChanged, { passive: true });
    view.addEventListener('blur', () => { composing = null; reset(); });
    view.addEventListener('focus', () => schedule({ instant: true }));
    view.addEventListener('pagehide', reset);
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) reset(); else schedule({ instant: true }); });
    motion.addEventListener('change', () => { reset(); schedule({ instant: true }); });
    view.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { reset(); schedule({ instant: true }); });
    return { reset, revealPaste, revealImage };
  }

  function observe(doc) {
    if (!controllers.has(doc)) controllers.set(doc, createController(doc));
    return controllers.get(doc);
  }

  window.MyScholarWritingMotion = {
    observe,
    reset: (doc) => controllers.get(doc)?.reset(),
    revealPaste: (editor, range) => observe(editor.ownerDocument).revealPaste(editor, range),
    revealImage: (editor, image) => observe(editor.ownerDocument).revealImage(editor, image),
  };
  observe(document);
})();
