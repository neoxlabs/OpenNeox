import { padLeft, padRight, truncate } from '../vendor/strutil/index.mjs';

export function formatRow(label, value, width) {
  return `${padLeft(label, width)}${padRight(value, width)}`;
}

export function shorten(title, max) {
  return truncate(title, max);
}
