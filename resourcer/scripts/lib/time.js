'use strict';

const TZ = 'Europe/London';

function londonParts(date) {
  const d = date || new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const part of fmt.formatToParts(d)) o[part.type] = part.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +o.hour, minute: +o.minute, second: +o.second,
    dow: dowMap[o.weekday],
    ymd: `${o.year}-${o.month}-${o.day}`,
  };
}

function londonHour(date) {
  return londonParts(date).hour;
}

// Tests only: RESOURCER_TEST_NOW (an ISO instant) replaces the clock for time-of-day decisions (operating window,
// alert quiet hours) so the end-to-end rehearsal runs at any real hour. Ages and timestamps keep the real clock.
function hourClock(date) {
  const t = process.env.RESOURCER_TEST_NOW;
  if (t) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return date || new Date();
}

module.exports = { TZ, londonParts, londonHour, hourClock };
