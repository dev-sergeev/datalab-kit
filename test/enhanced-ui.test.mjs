import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Theme } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, getKeybindings, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { requestEnhancedApproval } from '../dist/enhanced-ui.js';

const request = {
  command: 'rm -rf ./customer-data',
  reasons: ['Deletes customer data'],
  cwd: '/workspace',
  toolName: 'bash',
  agentName: 'research-worker',
  policyChecks: [],
};

function liveUI({ width = 80, rows = 24, theme = new Theme(
  { error: '#ff0000', muted: '#808080', text: '#ffffff', thinkingXhigh: '#ff0000' },
  { selectedBg: '#202020' }, 'truecolor',
) } = {}) {
  let component;
  let settled = false;
  let customOptions;
  let open;
  const opened = new Promise(resolve => { open = resolve; });
  const tui = { terminal: { rows, columns: width }, requestRender() {} };
  const ctx = {
    mode: 'tui', hasUI: true,
    ui: {
      async custom(factory, options) {
        customOptions = options;
        return new Promise((resolve, reject) => {
          Promise.resolve(factory(tui, theme, getKeybindings(), value => {
            settled = true;
            resolve(value);
          })).then(value => {
            component = value;
            component.focused = true;
            open();
          }, reject);
        });
      },
      input() { throw new Error('Native TUI must not use RPC input'); },
      select() { throw new Error('Enhanced approval must not use a selector'); },
    },
  };
  return {
    ctx, opened,
    get settled() { return settled; },
    get customOptions() { return customOptions; },
    key(data) { component.handleInput(data); },
    render(columns = width) { return component.render(columns); },
    text(columns = width) { return component.render(columns).map(stripTerminalSequences).join('\n'); },
  };
}

test('dangerous invocation is disclosed inline and exact yes only approves after Enter', async () => {
  const ui = liveUI();
  const result = requestEnhancedApproval(ui.ctx, request);
  await ui.opened;
  assert.equal(ui.customOptions?.overlay, false);
  const text = ui.text();
  assert.ok(text.includes(request.command));
  assert.ok(text.includes(request.reasons[0]));
  assert.ok(text.includes(request.cwd));
  assert.ok(text.includes(request.agentName));
  assert.ok(ui.render().join('\n').includes(CURSOR_MARKER), 'real focused input places the hardware cursor');
  ui.key('y'); ui.key('e'); ui.key('s');
  assert.equal(ui.settled, false, 'typing the third character is not submission');
  ui.key('\r');
  assert.equal(await result, true);
});

test('empty or inexact submissions stay editable, and cancellation never approves', async () => {
  for (const value of ['', 'YES', ' yes', 'yes ', 'no']) {
    const ui = liveUI();
    const result = requestEnhancedApproval(ui.ctx, request);
    await ui.opened;
    if (value) ui.key(value);
    ui.key('\r');
    assert.equal(ui.settled, false, JSON.stringify(value));
    ui.key('\x15');
    ui.key('yes');
    ui.key('\r');
    assert.equal(await result, true, 'the user can correct an invalid submission');
  }
  for (const key of ['\x1b', '\x03']) {
    const ui = liveUI();
    const result = requestEnhancedApproval(ui.ctx, request);
    await ui.opened;
    ui.key('yes');
    ui.key(key);
    assert.equal(await result, false);
  }
});

test('lifecycle abort cancels the local approval and an already aborted request never opens UI', async () => {
  const ui = liveUI();
  const controller = new AbortController();
  const result = requestEnhancedApproval(ui.ctx, request, controller.signal);
  await ui.opened;
  ui.key('yes');
  controller.abort();
  assert.equal(await result, false);
  assert.equal(await requestEnhancedApproval({
    mode: 'tui', hasUI: true,
    ui: { custom() { throw new Error('Aborted request must not open UI'); } },
  }, request, controller.signal), false);
});

test('all of a huge invocation and every reason remain reviewable at narrow and wide widths', async () => {
  const command = `HEAD_${Array.from({ length: 400 }, (_, index) => `${index}:abcdef界;`).join('')}_DANGER_TAIL`;
  const reasons = ['Deletion', `REASON_${Array.from({ length: 100 }, (_, index) => `r${index};`).join('')}_REASON_TAIL`];
  for (const width of [12, 120]) {
    const ui = liveUI({ width });
    const result = requestEnhancedApproval(ui.ctx, { ...request, command, reasons });
    await ui.opened;
    const pages = [];
    let previous;
    for (let page = 0; page < 3000; page++) {
      const lines = ui.render();
      assert.ok(lines.length <= 24, 'approval stays within the terminal height');
      assert.ok(lines.every(line => visibleWidth(line) <= width), 'ANSI and wide characters fit the terminal');
      assert.ok(lines.join('\n').includes(CURSOR_MARKER), 'review retains the input cursor');
      const text = ui.text();
      if (text === previous) break;
      previous = text;
      pages.push(text.split('\n'));
      ui.key('\x1b[6;5~');
    }
    const common = new Set(pages[0].filter(line => pages.every(page => page.includes(line))));
    const review = pages.map(page => page.filter(line => !common.has(line)).join('')).join('').replace(/[╔╗╚╝═│\s]/gu, '');
    assert.ok(review.includes(command), 'scrolling reveals the complete command, including the danger tail');
    assert.ok(review.includes(reasons[1]), 'scrolling reveals every full reason');
    ui.key('\x1b[5;5~');
    assert.notEqual(ui.text(), previous, 'review can scroll back upward');
    ui.key('\x03');
    assert.equal(await result, false);
  }
});

test('untrusted terminal sequences and directional controls are visible data, never UI commands', async () => {
  const ui = liveUI({ width: 120, rows: 60 });
  const unsafe = {
    ...request,
    command: 'rm data\x1b[2J\x1b]8;;https://evil.invalid\x07hidden\x1b]8;;\x07\rTAIL',
    reasons: ['reason\x1b[0mFORGED\x08tail\u202e'],
    cwd: '/workspace\x1b[Hspoof',
    agentName: 'worker\x9b2J',
  };
  const result = requestEnhancedApproval(ui.ctx, unsafe);
  await ui.opened;
  const rendered = ui.render().join('\n');
  const text = ui.text();
  assert.ok(rendered.includes('\x1b[31m'), 'approval is deliberately red, not a normal warning accent');
  assert.ok(!rendered.includes('\x1b[2J'));
  assert.ok(!rendered.includes('\x1b]8;'));
  assert.ok(!rendered.includes('\u202e'));
  assert.ok(!rendered.includes('\x9b'));
  assert.ok(!rendered.includes('\r'));
  assert.ok(text.includes('\\x1b[2J'));
  assert.ok(text.includes('\\x07'));
  assert.ok(text.includes('\\x08'));
  assert.ok(text.includes('\\u202e'));
  assert.ok(text.includes('TAIL'));
  ui.key('\x03');
  assert.equal(await result, false);
});

test('RPC prompts disclose the complete request and require raw exact yes', async () => {
  for (const answer of ['yes', 'YES', ' yes', 'yes ', '', undefined]) {
    let disclosure;
    const controller = new AbortController();
    const ctx = {
      mode: 'rpc', hasUI: true,
      ui: {
        async input(title, _placeholder, options) {
          disclosure = title;
          assert.equal(options.signal, controller.signal);
          return answer;
        },
        custom() { throw new Error('RPC must not use a terminal component'); },
        select() { throw new Error('No selectors or session grants'); },
      },
    };
    assert.equal(await requestEnhancedApproval(ctx, request, controller.signal), answer === 'yes');
    for (const value of [request.command, request.cwd, request.agentName, ...request.reasons]) {
      assert.ok(disclosure.includes(value));
    }
  }
});

test('no live authority or failed native UI fails closed without a permissive fallback', async () => {
  for (const mode of ['tui', 'rpc', 'json', 'print']) {
    let prompts = 0;
    assert.equal(await requestEnhancedApproval({
      mode, hasUI: false,
      ui: { async input() { prompts++; return 'yes'; }, async custom() { prompts++; return true; } },
    }, request), false);
    assert.equal(prompts, 0);
  }
  for (const mode of ['json', 'print']) {
    assert.equal(await requestEnhancedApproval({
      mode, hasUI: true, ui: { async input() { return 'yes'; }, async custom() { return true; } },
    }, request), false);
  }
  assert.equal(await requestEnhancedApproval({ mode: 'tui', hasUI: true }, request), false);
  let fallbacks = 0;
  assert.equal(await requestEnhancedApproval({
    mode: 'tui', hasUI: true,
    ui: { custom() { throw new Error('Terminal UI unavailable'); }, input() { fallbacks++; return 'yes'; } },
  }, request), false);
  assert.equal(fallbacks, 0);
});

test('bracketed paste cannot normalize inexact or control-bearing text into approval', async () => {
  for (const value of ['yes\n', '\tyes', 'yes\x1b[2J', 'yes\r']) {
    const ui = liveUI();
    const result = requestEnhancedApproval(ui.ctx, request);
    await ui.opened;
    ui.key(`\x1b[200~${value}\x1b[201~`);
    ui.key('\r');
    assert.equal(ui.settled, false, 'raw pasted text is not exact yes');
    assert.ok(!ui.render().join('\n').includes('\x1b[2J'));
    ui.key('\x03');
    assert.equal(await result, false);
  }
  const ui = liveUI();
  const result = requestEnhancedApproval(ui.ctx, request);
  await ui.opened;
  ui.key('\x1b[200~yes\x1b[201~');
  assert.equal(ui.settled, false);
  ui.key('\r');
  assert.equal(await result, true);
});

test('RPC cancellation resolves false even when the remote UI has not answered', async () => {
  const controller = new AbortController();
  const result = requestEnhancedApproval({
    mode: 'rpc', hasUI: true,
    ui: { input() { return new Promise(() => {}); } },
  }, request, controller.signal);
  controller.abort();
  assert.equal(await result, false);
});

test('a custom surface that cannot render cancels rather than leaving approval live', async () => {
  const ui = liveUI({ theme: { bold() { throw new Error('Theme rendering failed'); } } });
  const result = requestEnhancedApproval(ui.ctx, request);
  await ui.opened;
  assert.doesNotThrow(() => ui.render());
  assert.equal(await result, false);
});
