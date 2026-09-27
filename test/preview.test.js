'use strict';

// 固定时区，让 date/time 渲染断言可复现
process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const { previewOne } = require('../lib/preview');

/** 便捷构造：单语言预览 */
function run(message, params, lang = 'zh-CN', key = 'k') {
  return previewOne(lang, { [key]: message }, key, params);
}

test('普通占位符与 select 渲染成功', () => {
  const r = run('{gender, select, female{她} male{他} other{TA}} 向你问好，{name}！', {
    gender: 'female',
    name: '小明',
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '她 向你问好，小明！');
});

test('number 按语言自身的数字格式渲染', () => {
  const zh = run('已用 {used, number, percent}', { used: 0.75 }, 'zh-CN');
  const ar = run('已用 {used, number, percent}', { used: 0.75 }, 'ar');
  assert.equal(zh.ok, true);
  assert.ok(zh.text.includes('75%'));
  assert.equal(ar.ok, true);
  assert.notEqual(ar.text, zh.text); // 阿拉伯语使用自己的数字与百分号
});

test('date/time 值须为带时区的 ISO 8601 字符串，渲染时转成日期', () => {
  const r = run(
    '会议时间：{start, date, medium} {start, time, short}',
    { start: '2026-09-27T12:00:00Z' },
    'zh-CN',
  );
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('2026年9月27日'), r.text);
  assert.ok(r.text.includes('12:00'), r.text);
});

test('date/time 缺少时区或格式非法逐语言报错', () => {
  for (const bad of ['2026-09-27', '2026-09-27T12:00:00', '不是日期', 123]) {
    const r = run('{start, date, medium}', { start: bad });
    assert.equal(r.ok, false, `应拒绝：${bad}`);
    assert.ok(r.error.includes('「start」'), r.error);
    assert.ok(r.error.includes('带时区的 ISO 8601'), r.error);
  }
});

test('number 与复数值须为有限数字', () => {
  for (const bad of ['3', NaN, Infinity, null, true, {}]) {
    const r = run('{n, number}', { n: bad });
    assert.equal(r.ok, false, `应拒绝：${bad}`);
    assert.ok(r.error.includes('有限数字'), r.error);
  }
});

test('普通与 select 值须为字符串', () => {
  const plain = run('你好 {name}', { name: 42 });
  assert.equal(plain.ok, false);
  assert.ok(plain.error.includes('「name」') && plain.error.includes('字符串'));

  const sel = run('{g, select, male{他} other{TA}}', { g: 1 });
  assert.equal(sel.ok, false);
  assert.ok(sel.error.includes('「g」') && sel.error.includes('字符串'));
});

test('实际走到的分支缺值才报错；未走到的分支不校验', () => {
  const msg = '{g, select, a{{x}} other{{y}}}';
  const okRow = run(msg, { g: 'a', x: '甲' });
  assert.equal(okRow.ok, true);
  assert.equal(okRow.text, '甲');

  const badRow = run(msg, { g: 'a' });
  assert.equal(badRow.ok, false);
  assert.ok(badRow.error.includes('缺少参数「x」'), badRow.error);
});

test('嵌套分支：select 内 plural 按实际路径校验并渲染', () => {
  const msg = '{g, select, female{{n, plural, one{她有 # 只猫} other{她有 # 只猫}}} other{TA 有猫}}';
  const r = run(msg, { g: 'female', n: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.text, '她有 2 只猫');

  const missing = run(msg, { g: 'female' });
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes('缺少参数「n」'), missing.error);
});

test('plural 使用各语言自身的复数规则', () => {
  const msg = '{n, plural, one{one} other{other}}';
  const en = run(msg, { n: 1 }, 'en');
  const ja = run(msg, { n: 1 }, 'ja');
  assert.equal(en.text, 'one'); // 英语 n=1 属于 one
  assert.equal(ja.text, 'other'); // 日语没有 one 类别
});

test('selectordinal 与显式 =n 分支', () => {
  const ordinal = run('{r, selectordinal, one{#st} two{#nd} few{#rd} other{#th}}', { r: 2 }, 'en');
  assert.equal(ordinal.ok, true);
  assert.equal(ordinal.text, '2nd');

  const exact = run('{n, plural, =0{没有} other{# 个}}', { n: 0 });
  assert.equal(exact.text, '没有');
});

test('plural offset 参与类别选择', () => {
  const msg = '{n, plural, offset:1 =0{零} one{一} other{还有 # 个}}';
  // en 有 one 类别：n=2，offset 后为 1 → one 类别
  assert.equal(run(msg, { n: 2 }, 'en').text, '一');
  // n=0：显式 =0 优先于 offset
  assert.equal(run(msg, { n: 0 }, 'en').text, '零');
});

test('缺失消息只影响对应语言', () => {
  const r = previewOne('ja', { other: '他' }, 'k', {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('缺失'));
  // 另一语言不受影响
  const ok = previewOne('en', { k: 'hi {name}' }, 'k', { name: 'Ann' });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'hi Ann');
});

test('无效语言代码只影响对应语言', () => {
  const r = run('你好 {name}', { name: '小明' }, '译文1');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('无效语言代码'), r.error);
});

test('模板语法错误只影响对应语言', () => {
  const bad = previewOne('zh-TW', { k: '未闭合 {x' }, 'k', {});
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('语法错误'), bad.error);

  const good = previewOne('ja', { k: 'こんにちは' }, 'k', {});
  assert.equal(good.ok, true);
  assert.equal(good.text, 'こんにちは');
});

test('消息值不是字符串时该语言报错', () => {
  const r = previewOne('ja', { k: 42 }, 'k', {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('不是字符串'));
});

test('select 值未命中选项且缺少 other 时报错', () => {
  const r = run('{g, select, male{他} female{她}}', { g: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('other'), r.error);
});

test('参数值 JSON 中多出的未使用参数不影响渲染', () => {
  const r = run('你好 {name}', { name: '小明', unused: 1, another: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '你好 小明');
});
