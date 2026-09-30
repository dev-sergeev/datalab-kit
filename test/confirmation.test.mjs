import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfirmationDialog } from '../dist/confirmation.js';

const theme = { fg: (_color, text) => text, bold: text => text };

test('Enter cancels an опасная команда; down then Enter approves only this invocation', () => {
  const outcomes = [];
  const dialog = new ConfirmationDialog('rm important.txt', theme, value => outcomes.push(value));
  assert.match(dialog.render(70).join('\n'), /Отмена/);
  dialog.handleInput('\r');
  assert.deepEqual(outcomes, [false]);

  const second = new ConfirmationDialog('rm important.txt', theme, value => outcomes.push(value));
  second.handleInput('\u001b[B');
  second.handleInput('\r');
  assert.deepEqual(outcomes, [false, true]);
  const next = new ConfirmationDialog('rm important.txt', theme, value => outcomes.push(value));
  next.handleInput('\r');
  assert.deepEqual(outcomes, [false, true, false]);
});
