'use strict';

const IntlMessageFormat = require('intl-messageformat').default;
const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');
const { USAGE_LABELS } = require('./audit');

/** 带时区的 ISO 8601 日期时间字符串，如 2026-09-27T10:00:00+08:00 / 2026-09-27T02:00:00Z */
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** 各用法类型对参数值的要求 */
const EXPECTED = {
  plain: '字符串',
  number: '有限数字',
  date: '带时区的 ISO 8601 字符串（如 2026-09-27T10:00:00+08:00）',
  time: '带时区的 ISO 8601 字符串（如 2026-09-27T10:00:00+08:00）',
  select: '字符串',
  plural: '有限数字',
  selectordinal: '有限数字',
};

/** 参数值的可读描述（用于类型不符的报错） */
function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  if (typeof v === 'number') return Number.isFinite(v) ? `数字 ${v}` : `非有限数字（${String(v)}）`;
  if (typeof v === 'string') return `字符串「${v}」`;
  if (typeof v === 'boolean') return `布尔值 ${v}`;
  if (typeof v === 'object') return '对象';
  return typeof v;
}

const has = (params, name) => Object.prototype.hasOwnProperty.call(params, name);

/** 校验参数存在；缺失时报错并返回 false */
function requireValue(errors, params, name, usage) {
  if (has(params, name)) return true;
  errors.push(`缺少参数「${name}」的值（用法：${USAGE_LABELS[usage]}）`);
  return false;
}

/** 校验参数类型；不符时报错并返回 false */
function requireType(errors, params, name, usage, ok) {
  if (ok) return true;
  errors.push(
    `参数「${name}」（${USAGE_LABELS[usage]}）应为${EXPECTED[usage]}，实际为${describeValue(params[name])}`,
  );
  return false;
}

/**
 * 按给定参数值走一遍 AST，只进入实际选中的分支：
 * 校验沿途参数的存在性与类型，并把 date/time 参数转换为 Date 写入 values。
 * 未走到的分支不校验；错误（中文描述）追加到 errors。
 */
function validateElements(elements, params, values, errors, pluralRules) {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
        if (requireValue(errors, params, el.value, 'plain')) {
          requireType(errors, params, el.value, 'plain', typeof params[el.value] === 'string');
        }
        break;

      case TYPE.number:
        if (requireValue(errors, params, el.value, 'number')) {
          requireType(
            errors, params, el.value, 'number',
            typeof params[el.value] === 'number' && Number.isFinite(params[el.value]),
          );
        }
        break;

      case TYPE.date:
      case TYPE.time: {
        const usage = el.type === TYPE.date ? 'date' : 'time';
        if (!requireValue(errors, params, el.value, usage)) break;
        const v = params[el.value];
        const valid = typeof v === 'string' && ISO_WITH_TZ.test(v) && !Number.isNaN(Date.parse(v));
        if (requireType(errors, params, el.value, usage, valid)) {
          values[el.value] = new Date(v); // 带时区的 ISO 字符串 → 日期对象
        }
        break;
      }

      case TYPE.select: {
        if (!requireValue(errors, params, el.value, 'select')) break;
        if (!requireType(errors, params, el.value, 'select', typeof params[el.value] === 'string')) break;
        const option = el.options[params[el.value]] || el.options.other;
        if (!option) {
          errors.push(`select 参数「${el.value}」的值「${params[el.value]}」未命中任何选项，且模板缺少 other 分支`);
          break;
        }
        validateElements(option.value, params, values, errors, pluralRules);
        break;
      }

      case TYPE.plural: {
        const usage = el.pluralType === 'ordinal' ? 'selectordinal' : 'plural';
        if (!requireValue(errors, params, el.value, usage)) break;
        const v = params[el.value];
        if (!requireType(errors, params, el.value, usage, typeof v === 'number' && Number.isFinite(v))) break;
        // 显式 =n 优先（与原始值比较）；否则按该语言的复数规则对（值 − offset）取类别
        let option = el.options[`=${v}`];
        if (!option) {
          const rules = el.pluralType === 'ordinal' ? pluralRules.ordinal : pluralRules.cardinal;
          const category = rules.select(v - (el.offset || 0));
          option = el.options[category] || el.options.other;
        }
        if (!option) {
          errors.push(`复数参数「${el.value}」的值 ${v} 未命中任何分支，且模板缺少 other 分支`);
          break;
        }
        validateElements(option.value, params, values, errors, pluralRules);
        break;
      }

      case TYPE.tag:
        validateElements(el.children, params, values, errors, pluralRules);
        break;

      default:
        break; // literal / pound 无需处理
    }
  }
}

/**
 * 用一份参数值渲染某个语言下指定键的消息。
 * 任何失败（无效语言代码、缺失消息、模板错误、走到分支的参数缺值/类型不符、渲染异常）
 * 都只体现为该语言一行的失败原因。
 *
 * @param {string} lang 语言代码
 * @param {Object<string,string>} messages 该语言的平铺消息对象
 * @param {string} key 要渲染的消息键
 * @param {Object<string,*>} params 参数值（已解析的 JSON 对象）
 * @returns {{language:string, ok:boolean, text?:string, error?:string}}
 */
function previewOne(lang, messages, key, params) {
  try {
    Intl.getCanonicalLocales(lang);
  } catch {
    return { language: lang, ok: false, error: `无效语言代码「${lang}」` };
  }

  if (!has(messages, key)) {
    return { language: lang, ok: false, error: '译文中缺失该消息' };
  }
  const message = messages[key];
  if (typeof message !== 'string') {
    return { language: lang, ok: false, error: `消息值不是字符串（实际为${describeValue(message)}）` };
  }

  let ast;
  try {
    ast = parse(message, { requiresOtherClause: false, shouldParseSkeletons: false });
  } catch (err) {
    return { language: lang, ok: false, error: `ICU 语法错误：${err.message}` };
  }

  const pluralRules = {
    cardinal: new Intl.PluralRules(lang),
    ordinal: new Intl.PluralRules(lang, { type: 'ordinal' }),
  };
  const values = { ...params };
  const errors = [];
  validateElements(ast, params, values, errors, pluralRules);
  if (errors.length) {
    return { language: lang, ok: false, error: errors.join('；') };
  }

  try {
    const text = new IntlMessageFormat(message, lang).format(values);
    return { language: lang, ok: true, text };
  } catch (err) {
    return { language: lang, ok: false, error: `渲染失败：${err.message}` };
  }
}

module.exports = { previewOne, ISO_WITH_TZ };
