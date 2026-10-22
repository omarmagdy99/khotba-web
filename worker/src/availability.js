// أوقاف 15 مايو والتبين — نقطة تصدير دوال التوفر لبيئة Cloudflare Workers و Node.js
import pkg from '../../assets/availability.js';

export const {
  HIJRI_CALENDAR_POLICY,
  WEEK_ORDINAL_NAMES_AR,
  parseCivilDate,
  assertFriday,
  resolveCalendar,
  getCalendarDateParts,
  getFridayOrdinal,
  validateAvailability,
  normalizeAvailability,
  parseStoredAvailability,
  formatAvailabilityRule,
  isKhatibAvailable,
} = pkg;

export default pkg;
