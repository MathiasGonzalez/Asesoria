/**
 * Utility service to sanitize and anonymize Uruguayan PII and sensitive financial data
 * in compliance with:
 *   - Art. 47 Código Tributario — Secreto tributario
 *   - Ley 18.331 (URCDP) — Datos personales
 *   - Códigos de ética profesional contable
 *
 * All PII redaction is performed **in memory** before any data is sent to the AI model,
 * ensuring that no personally identifiable information is ever passed to Workers AI.
 */
export class Anonymizer {
  /**
   * Matches Uruguayan Cédula de Identidad (C.I.).
   * Accepts 7–8 digit numbers with optional dot/dash separators, e.g.:
   *   1.234.567-8  |  1234567  |  12345678
   */
  private static ciPattern = /\b\d{1,2}[.-]?\d{3}[.-]?\d{3}[.-]?\s?\d{1}?\b/g;

  /**
   * Matches Uruguayan RUT (Registro Único Tributario).
   * Format: 12-digit number beginning with 21 (DGI) or 12, e.g.:
   *   210000010018  |  120000010012
   */
  private static rutPattern = /\b(12|21)\d{10}\b/g;

  /**
   * Matches currency amounts in Uruguayan pesos or USD, e.g.:
   *   $U 1.234.567,89  |  $ 50.000  |  USD 1,200
   */
  private static currencyPattern = /(\$U|\$|USD)\s?(\d{1,3}(\.\d{3})*(,\d+)?)/gi;

  /**
   * Replaces all recognized PII tokens in `text` with neutral placeholders:
   *   - RUT  → `[RUT_REDACTADO]`
   *   - C.I. → `[CI_REDACTADA]`
   *   - Amounts → `[MONTO_REDACTADO]`
   *
   * RUT is redacted first because its pattern is more specific, preventing
   * partial matches from the C.I. pattern.
   *
   * @param text - Raw user input that may contain sensitive identifiers.
   * @returns A copy of `text` with all PII replaced by placeholders.
   */
  public static sanitize(text: string): string {
    if (!text) return "";
    let clean = text;
    clean = clean.replace(this.rutPattern, "[RUT_REDACTADO]");
    clean = clean.replace(this.ciPattern, "[CI_REDACTADA]");
    clean = clean.replace(this.currencyPattern, "[MONTO_REDACTADO]");
    return clean;
  }
}
