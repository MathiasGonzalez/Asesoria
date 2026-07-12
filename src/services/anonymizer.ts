/**
 * Utility service to sanitize and anonymize Uruguayan PII and sensitive financial data
 * in compliance with Tax Secrecy (Article 47 CT), Ethics Codes, and URCDP guidelines.
 */
export class Anonymizer {
  // Regex pattern for Uruguayan C.I. (7 or 8 digits, optional dashes/dots)
  private static ciPattern = /\b\d{1,2}[.-]?\d{3}[.-]?\d{3}[.-]?\s?\d{1}?\b/g;

  // Regex pattern for RUT (12-digit numbers starting with 21 or 12)
  private static rutPattern = /\b(12|21)\d{10}\b/g;

  // Regex pattern for currency values in UYU ($U, $, pesos)
  private static currencyPattern = /(\$U|\$|USD)\s?(\d{1,3}(\.\d{3})*(,\d+)?)/gi;

  public static sanitize(text: string): string {
    if (!text) return "";
    let clean = text;
    clean = clean.replace(this.rutPattern, "[RUT_REDACTADO]");
    clean = clean.replace(this.ciPattern, "[CI_REDACTADA]");
    clean = clean.replace(this.currencyPattern, "[MONTO_REDACTADO]");
    return clean;
  }
}
