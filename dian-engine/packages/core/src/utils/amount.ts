/**
 * Truncates a number to N decimal places WITHOUT rounding.
 * Critical for CUFE/CUDE computation: DIAN requires truncation, not rounding.
 * Using Math.round instead of Math.trunc causes DIAN rejection errors CAD06/FAD06.
 *
 * @param value - The numeric value to truncate
 * @param decimals - Number of decimal places to keep
 * @returns String representation of the truncated number with exact decimal places
 *
 * @example
 * ```typescript
 * truncateDecimals(100.456, 2); // "100.45"
 * truncateDecimals(99.999, 2);  // "99.99"
 * ```
 */
export function truncateDecimals(value: number, decimals: number): string {
  const multiplier = 10 ** decimals;
  const truncated = Math.trunc(value * multiplier) / multiplier;
  return truncated.toFixed(decimals);
}

/**
 * Formats a monetary amount for UBL XML output with 2 decimal places and no thousands separator.
 * Uses truncation (not rounding) to comply with DIAN CUFE/CUDE requirements.
 *
 * @param value - Monetary amount to format
 * @returns Formatted string with exactly 2 decimal places (e.g., "1500.00")
 *
 * @example
 * ```typescript
 * formatAmount(1500);     // "1500.00"
 * formatAmount(99.999);   // "99.99"
 * ```
 */
export function formatAmount(value: number): string {
  return truncateDecimals(value, 2);
}

/**
 * Formats a tax percentage for UBL XML output with 2 decimal places.
 *
 * @param value - Tax percentage to format (e.g., 19 for 19%)
 * @returns Formatted string with exactly 2 decimal places (e.g., "19.00")
 *
 * @example
 * ```typescript
 * formatPercent(19);   // "19.00"
 * formatPercent(5);    // "5.00"
 * ```
 */
export function formatPercent(value: number): string {
  return value.toFixed(2);
}

/**
 * Formats a Date object as an ISO 8601 date-only string (YYYY-MM-DD).
 * Used for IssueDate, StartDate, EndDate, and other date elements in UBL XML.
 *
 * @param date - Date object to format
 * @returns Date string in YYYY-MM-DD format (e.g., "2024-01-15")
 *
 * @example
 * ```typescript
 * formatDate(new Date(2024, 0, 15)); // "2024-01-15"
 * ```
 */
export function formatDate(date: Date): string {
  // UTC, not local time: every date this formats (numbering StartDate/
  // EndDate, IssueDate, etc.) is stored and compared as a plain calendar
  // date in UTC. Using the local-timezone getters here shifted every date
  // back by one day on any server running west of UTC (e.g. Colombia,
  // UTC-5) - a stored "2019-01-19T00:00:00.000Z" numbering resolution
  // start date rendered as "2019-01-18", which DIAN rejects outright
  // (FAB07b/FAB08b: "fecha ... no corresponde a la ... vigente").
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Formats a Date object as a time string with timezone offset (HH:MM:SS+/-HH:MM).
 * DIAN requires the timezone offset in the IssueTime element.
 * Defaults to Colombia's UTC-05:00 offset.
 *
 * @param date - Date object from which to extract hours, minutes, and seconds
 * @param utcOffset - Timezone offset string (defaults to "-05:00" for Colombia)
 * @returns Time string with offset (e.g., "14:30:00-05:00")
 *
 * @example
 * ```typescript
 * formatTime(new Date(2024, 0, 15, 14, 30, 0)); // "14:30:00-05:00"
 * ```
 */
export function formatTime(date: Date, utcOffset = "-05:00"): string {
  // Wall-clock time for `utcOffset`, computed from the UTC instant - not
  // the server's own local timezone (same bug class as formatDate: the
  // previous getHours()/getMinutes()/getSeconds() only produced Colombia
  // time by coincidence, when the server's OS timezone happened to also be
  // UTC-05:00. On any other server timezone this silently produced the
  // wrong wall-clock time while still claiming the "-05:00" offset.
  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  const offsetMinutes = offsetMatch
    ? (offsetMatch[1] === "-" ? -1 : 1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]))
    : 0;
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const h = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  const s = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${h}:${min}:${s}${utcOffset}`;
}
