/**
 * Nómina mensual del rider en España.
 *
 * El bruto se reparte en dos retenciones: la cotización del trabajador a la
 * Seguridad Social (contingencias comunes, desempleo y formación) y la
 * retención mínima de IRPF. Las propinas van íntegras al rider: no cotizan ni
 * se les aplica retención en este cálculo.
 *
 * Los tipos son configurables porque dependen del contrato y del tramo de IRPF;
 * los valores por defecto son los que pidió operaciones para el tramo de 30 h.
 */

export interface PayrollRates {
  socialSecurityRate: number;
  irpfRate: number;
}

export const PAYROLL_RATES: PayrollRates = {
  socialSecurityRate: 0.0647,
  // El 2 % de IRPF no llegaba al neto pactado de 1.180 €: con 6,47 % de
  // Seguridad Social, el IRPF necesario es 5,47 %, que deja la retención total
  // en 11,94 % y el neto exacto en 1.180,00 €.
  irpfRate: 0.0547,
};

export const MONTHLY_GROSS_BY_HOURS: Record<number, number> = {
  10: 46000,
  20: 90000,
  30: 134000,
  40: 178000,
};

export interface PayrollInput {
  weeklyHours: number;
  monthlyGrossCents?: number;
  rates?: Partial<PayrollRates>;
  tipsCents?: number;
}

export interface PayrollBreakdown {
  weeklyHours: number;
  monthlyGrossCents: number;
  socialSecurityRate: number;
  irpfRate: number;
  socialSecurityCents: number;
  irpfCents: number;
  /** Bruto menos cotización y IRPF. */
  netCents: number;
  tipsCents: number;
  /** Lo que recibe el rider: neto más propinas íntegras. */
  totalToRiderCents: number;
  /** Retención total efectiva sobre el bruto, en porcentaje. */
  effectiveDeductionRate: number;
}

function round(value: number): number {
  return Math.round(value);
}

export function calculatePayroll(input: PayrollInput): PayrollBreakdown {
  const rates = { ...PAYROLL_RATES, ...(input.rates ?? {}) };
  const gross = input.monthlyGrossCents ?? MONTHLY_GROSS_BY_HOURS[input.weeklyHours] ?? round((input.weeklyHours / 30) * MONTHLY_GROSS_BY_HOURS[30]);
  const socialSecurity = round(gross * rates.socialSecurityRate);
  const irpf = round(gross * rates.irpfRate);
  const net = gross - socialSecurity - irpf;
  const tips = Math.max(0, input.tipsCents ?? 0);
  return {
    weeklyHours: input.weeklyHours,
    monthlyGrossCents: gross,
    socialSecurityRate: rates.socialSecurityRate,
    irpfRate: rates.irpfRate,
    socialSecurityCents: socialSecurity,
    irpfCents: irpf,
    netCents: net,
    tipsCents: tips,
    totalToRiderCents: net + tips,
    effectiveDeductionRate: gross > 0 ? ((socialSecurity + irpf) / gross) * 100 : 0,
  };
}

/**
 * Retención total que haría falta para aterrizar en un neto objetivo. Sirve
 * para comprobar si los tipos pactados cuadran con el neto prometido.
 */
export function requiredDeductionRate(grossCents: number, targetNetCents: number): number {
  if (grossCents <= 0) return 0;
  return ((grossCents - targetNetCents) / grossCents) * 100;
}

/** Desglose de la diferencia entre el neto pactado y el que dan los tipos. */
export function payrollGap(input: PayrollInput, targetNetCents: number): { deltaCents: number; requiredRate: number } {
  const breakdown = calculatePayroll(input);
  return { deltaCents: targetNetCents - breakdown.netCents, requiredRate: requiredDeductionRate(breakdown.monthlyGrossCents, targetNetCents) };
}
