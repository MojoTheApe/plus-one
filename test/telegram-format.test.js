import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTelegramHtml } from '../src/telegram-format.js';

test('research HTML and Markdown links survive as Telegram anchors, including appended sources', () => {
  const result = renderTelegramHtml('**Коротко**\n[Статистика](https://example.org/stats)\nДжерела: <a href="https://example.org/report?a=1&amp;b=2">Звіт</a>');
  assert.match(result, /<b>Коротко<\/b>/);
  assert.match(result, /<a href="https:\/\/example.org\/stats">/);
  assert.match(result, /href="https:\/\/example.org\/report\?a=1&amp;b=2"/);
  assert.ok(!result.includes('&lt;a'));
});

test('link labels expose the actual domain and untrusted markup cannot become active HTML', () => {
  const result = renderTelegramHtml('<a href="https://mirror.example/article">The Verge</a> <script>bad()</script> <a href="javascript:bad()">unsafe</a>');
  assert.match(result, /The Verge \(mirror.example\)/);
  assert.ok(!result.includes('href="javascript:'));
  assert.match(result, /&lt;script&gt;/);
  assert.ok(!renderTelegramHtml('[secret](https://user:password@example.org/path)').includes('href='));
});

test('code is literal evidence, including underscores, comparisons and link-like content',()=>{
  assert.equal(renderTelegramHtml('`some_value`'),'<code>some_value</code>');
  assert.equal(renderTelegramHtml('<code>x < y > z</code>'),'<code>x &lt; y &gt; z</code>');
  assert.equal(renderTelegramHtml('`[link](https://example.org)`'),'<code>[link](https://example.org)</code>');
});
