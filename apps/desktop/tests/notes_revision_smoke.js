'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) throw new Error('Use an isolated fixture server with MY_SCHOLAR_TEST_DATA. This suite writes fixture notes.');
(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1460, height: 960 } });
    page.setDefaultTimeout(15000);
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    const paper = page.locator('#library-view .library-card[data-status="completed"]').first();
    await paper.waitFor();
    const jobId = await paper.getAttribute('data-job-id');
    const notesURL = `${baseURL}/api/jobs/${jobId}/notes`;
    const read = async () => (await page.request.get(notesURL)).json();
    const externalWrite = async (markdown) => {
      const before = await read();
      const response = await page.request.post(`${baseURL}/api/capabilities/call`, { data: { name: 'save_notes', arguments: { job_id: jobId, markdown, expected_revision: before.revision } } });
      assert(response.ok(), await response.text());
    };
    await paper.locator('.library-row-name').dblclick();
    await page.locator('[data-panel="notes-panel"]').click();
    const editor = page.locator('#notes-editor');
    await page.waitForFunction(() => document.querySelector('#notes-editor').contentEditable === 'true');
    const initial = await read();
    const firstSave = page.waitForResponse((response) => response.url() === notesURL && response.request().method() === 'PUT');
    await editor.fill('local initial notes');
    await page.locator('#save-notes-button').click();
    const saved = await firstSave;
    assert.equal(saved.status(), 200);
    assert.equal(saved.request().postDataJSON().expected_revision, initial.revision);
    await externalWrite('external MCP notes');
    const conflictSave = page.waitForResponse((response) => response.url() === notesURL && response.request().method() === 'PUT' && response.status() === 409);
    await editor.fill('local draft must survive');
    await page.locator('#save-notes-button').click();
    await conflictSave;
    await page.locator('#notes-conflict:not([hidden])').waitFor();
    assert.equal(await editor.innerText(), 'local draft must survive');
    assert.equal(await page.locator('#notes-external-version').inputValue(), 'external MCP notes');
    assert.equal((await read()).markdown, 'external MCP notes');
    await page.locator('#notes-conflict-reload').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(() => document.querySelector('#notes-editor').textContent.includes('external MCP notes'));
    assert(await page.locator('#notes-conflict').isHidden());
    await externalWrite('external next version');
    const nextConflict = page.waitForResponse((response) => response.url() === notesURL && response.request().method() === 'PUT' && response.status() === 409);
    await editor.fill('another local draft');
    await page.locator('#save-notes-button').click();
    await nextConflict;
    await page.locator('#notes-conflict:not([hidden])').waitFor();
    await editor.fill('external next version\n\nmerged local draft');
    await page.locator('#notes-conflict-merge').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    const mergeSave = page.waitForResponse((response) => response.url() === notesURL && response.request().method() === 'PUT' && response.status() === 200);
    await page.locator('#confirm-accept').click();
    await mergeSave;
    assert.match((await read()).markdown, /external next version[\s\S]*merged local draft/u);
    assert(await page.locator('#notes-conflict').isHidden());
    console.log('Notes revision smoke passed: expected revisions, MCP conflict protection, draft retention, external reload and explicit merge.');

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await editor.fill('Writing motion');
    await editor.press('End');
    const motionCaret = page.locator('.writing-motion-caret');
    const settledCaretX = async (previousX = 0, direction = 0) => {
      const result = await page.waitForFunction(({ previousX, direction }) => {
        const marker = document.querySelector('.writing-motion-caret:not([hidden]):not([data-moving])');
        const selection = document.getSelection();
        const editor = document.querySelector('#notes-editor.writing-motion-caret-active');
        if (!marker || !editor || !selection.isCollapsed || !selection.rangeCount) return false;
        const origin = editor.getBoundingClientRect().left;
        const x = marker.getBoundingClientRect().left - origin;
        const targetX = selection.getRangeAt(0).getBoundingClientRect().left - origin;
        return Math.abs(x - targetX) <= 2 && (!direction || (x - previousX) * direction > 2) ? x : false;
      }, { previousX, direction });
      return result.jsonValue();
    };
    const traceCaretGlide = async (eventType, edit) => {
      const trace = await editor.evaluateHandle((node, eventType) => {
        const marker = document.querySelector('.writing-motion-caret');
        const trace = { frames: [], done: false };
        node.addEventListener(eventType, (event) => {
          trace.trusted = event.isTrusted;
          trace.text = event.data;
          let remaining = 24;
          const sample = () => {
            const moving = !marker.hidden && marker.hasAttribute('data-moving');
            if (moving) trace.frames.push(marker.getBoundingClientRect().left - node.getBoundingClientRect().left);
            if (--remaining === 0 || (!moving && trace.frames.length)) trace.done = true;
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }, { once: true });
        return trace;
      }, eventType);
      try {
        await edit();
        await page.waitForFunction((trace) => trace.done, trace, { timeout: 3000 });
        return await trace.jsonValue();
      } finally {
        await trace.dispose();
      }
    };
    const assertCaretGlide = (trace, start, end, text) => {
      assert.equal(trace.text, text);
      assert(Math.abs(trace.frames[0] - start) <= 0.5, `First moving frame must start at ${start}: ${trace.frames}`);
      const left = Math.min(start, end);
      const right = Math.max(start, end);
      assert(trace.frames.some((x) => x > left + 0.5 && x < right - 0.5), `Caret must travel between ${start} and ${end}: ${trace.frames}`);
    };
    const beforeTyping = await settledCaretX();
    const typingGlide = await traceCaretGlide('input', () => editor.press('x'));
    assert.equal(typingGlide.trusted, true);
    const afterTyping = await settledCaretX(beforeTyping, 1);
    assertCaretGlide(typingGlide, beforeTyping, afterTyping, 'x');
    await editor.press('ArrowLeft');
    await settledCaretX(afterTyping, -1);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#notes-editor.writing-motion-caret-active').waitFor({ state: 'detached' });
    assert(await motionCaret.isHidden(), 'Reduced motion must restore the native caret');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await editor.evaluate(async (node) => {
      const panel = node.closest('#notes-panel');
      await Promise.all(panel.getAnimations().map((animation) => animation.finished));
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let last;
      while (walker.nextNode()) last = walker.currentNode;
      document.getSelection().collapse(last, last.length);
    });
    const beforeComposition = await settledCaretX();
    const cdp = await page.context().newCDPSession(page);
    try {
      let preeditX = beforeComposition;
      for (const text of ['zh', 'zhong']) {
        const preeditGlide = await traceCaretGlide('compositionupdate', () => cdp.send('Input.imeSetComposition', {
          text, selectionStart: text.length, selectionEnd: text.length,
        }));
        await motionCaret.waitFor({ state: 'hidden' });
        const preedit = await editor.evaluate((node) => {
          const selection = document.getSelection();
          return {
            text: node.textContent,
            x: selection.getRangeAt(0).getBoundingClientRect().left - node.getBoundingClientRect().left,
            nativeCaret: selection.isCollapsed && !node.classList.contains('writing-motion-caret-active'),
          };
        });
        assert.equal(preedit.text, `Writing motionx${text}`);
        assert(preedit.nativeCaret, 'Resting preedit must preserve the native caret');
        assert(preedit.x > preeditX + 2, `Preedit must advance to the right for ${text}`);
        assertCaretGlide(preeditGlide, preeditX, preedit.x, text);
        preeditX = preedit.x;
      }
      const compositionGlide = await traceCaretGlide('compositionend', () => cdp.send('Input.insertText', { text: '中' }));
      assert.equal(await editor.textContent(), 'Writing motionx中');
      const afterComposition = await settledCaretX(preeditX, -1);
      assertCaretGlide(compositionGlide, preeditX, afterComposition, '中');

      await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 0, selectionEnd: 3 });
      await motionCaret.waitFor({ state: 'hidden' });
      const selectedPreedit = await editor.evaluate((node) => ({
        text: document.getSelection().toString(),
        activeOverlay: node.classList.contains('writing-motion-caret-active'),
      }));
      assert.deepEqual(selectedPreedit, { text: 'pin', activeOverlay: false });
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      assert.equal(await editor.textContent(), 'Writing motionx中');
    } finally {
      await cdp.detach();
    }

    const copyFeedback = await editor.evaluate((node) => {
      const selection = document.getSelection();
      selection.selectAllChildren(node);
      const selected = selection.getRangeAt(0).getBoundingClientRect();
      node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }));
      return {
        text: selection.toString(),
        overlapsSelection: [...document.querySelectorAll('.writing-motion-copy')].some((fragment) => {
          const box = fragment.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.left < selected.right && box.right > selected.left
            && box.top < selected.bottom && box.bottom > selected.top;
        }),
      };
    });
    assert.deepEqual(copyFeedback, { text: 'Writing motionx中', overlapsSelection: true });
    await page.locator('.writing-motion-copy').first().waitFor({ state: 'detached' });

    await editor.evaluate((node) => {
      node.innerHTML = '<p>上一段</p><p><br></p><p>前文后文</p><p><br></p><p><br></p><p><br></p><p>下一段</p>';
    });
    const placeCaret = (selector, offset = 0) => editor.locator(selector).evaluate((block, caretOffset) => {
      block.closest('#notes-editor').focus();
      const anchor = block.firstChild?.nodeType === Node.TEXT_NODE ? block.firstChild : block;
      document.getSelection().collapse(anchor, caretOffset);
    }, offset);

    await placeCaret(':scope > p:nth-child(2)');
    await page.keyboard.insertText('##');
    await page.keyboard.press('Space');
    const heading = editor.locator(':scope > h2:nth-child(2)');
    assert.equal(await heading.count(), 1);
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal(await heading.count(), 0);
    assert.equal((await editor.locator(':scope > p:nth-child(2)').textContent()).trim(), '##');
    await page.keyboard.press('ControlOrMeta+Shift+Z');
    assert.equal(await heading.count(), 1);
    await page.keyboard.insertText('标题内容');
    assert.equal(await heading.textContent(), '标题内容');

    await placeCaret(':scope > p:nth-child(3)', '前文'.length);
    await page.keyboard.insertText('**重要**');
    await page.keyboard.press('Space');
    const inline = editor.locator(':scope > p:nth-child(3)');
    assert.equal(await inline.locator('strong').textContent(), '重要');
    assert.equal((await inline.textContent()).replace(/\s/gu, ' '), '前文重要 后文');

    await placeCaret(':scope > p:nth-child(4)');
    await page.keyboard.insertText('-');
    await page.keyboard.press('Space');
    await page.keyboard.insertText('列表项');
    assert.equal(await editor.locator(':scope > ul:nth-child(4) > li').textContent(), '列表项');

    await placeCaret(':scope > p:nth-child(5)');
    const pasteHighlight = await editor.evaluate((node) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '### 粘贴标题\n\n- 粘贴项目');
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      return Array.from(CSS.highlights.get('writing-motion-paste') || [], (highlighted) => {
        const range = document.createRange();
        range.setStart(highlighted.startContainer, highlighted.startOffset);
        range.setEnd(highlighted.endContainer, highlighted.endOffset);
        return range.toString();
      }).join('');
    });
    assert.match(pasteHighlight, /粘贴标题[\s\S]*粘贴项目/u);
    await page.waitForFunction(() => !CSS.highlights.has('writing-motion-paste'));
    assert.equal(await editor.locator(':scope > h3').textContent(), '粘贴标题');
    assert.equal(await editor.locator(':scope > ul > li').filter({ hasText: '粘贴项目' }).count(), 1);
    assert.equal(await editor.locator(':scope > p:first-child').textContent(), '上一段');
    assert.equal(await editor.locator(':scope > p:last-child').textContent(), '下一段');

    await placeCaret(':scope > p:nth-last-child(2)');
    await page.keyboard.insertText('/h2');
    const slashMenu = page.locator('#note-slash-menu');
    await slashMenu.locator('[data-note-slash="h2"][aria-selected="true"]').waitFor();
    const composingKeyUnconsumed = await editor.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', isComposing: true, bubbles: true, cancelable: true,
    })));
    assert.equal(composingKeyUnconsumed, true);
    assert.equal(await editor.locator(':scope > p:nth-last-child(2)').textContent(), '/h2');
    assert(await slashMenu.isVisible());
    assert.equal(await slashMenu.evaluate((menu) => getComputedStyle(menu).animationName), 'note-pop-in');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await slashMenu.evaluate((menu) => getComputedStyle(menu).animationName), 'none');
    const assistantToggle = page.locator('#assistant-toggle');
    await assistantToggle.click();
    assert.equal(await assistantToggle.getAttribute('aria-expanded'), 'false');
    await slashMenu.waitFor({ state: 'hidden' });
    console.log('Notes editor smoke passed: editing motion and cleanup, Markdown shortcuts and paste, undo and redo, and slash menu composition and dismissal.');
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
