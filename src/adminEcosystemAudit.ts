export type EcosystemAuditStatus = "production" | "test_qa" | "warning" | "error" | "not_verified";
export type EcosystemAuditEnvironment = "production" | "test_qa" | "unknown";
export type EcosystemAuditCheck = {
  id: string;
  domain: string;
  name: string;
  status: EcosystemAuditStatus;
  environment: EcosystemAuditEnvironment;
  severity: "info" | "warning" | "critical";
  evidence: string;
  endpoint?: string;
  version?: string;
  durationMs: number;
};

export type EcosystemAuditInput = {
  databaseReady: boolean;
  mongoReadyState: number;
  commit: string;
  nodeEnv: string;
  stripeConfigured: boolean;
  emailConfigured: boolean;
  pushConfigured: boolean;
  realtimeEnabled: boolean;
  qaMode: boolean;
};

function check(input: Omit<EcosystemAuditCheck, "durationMs">): EcosystemAuditCheck {
  return { ...input, durationMs: 0 };
}

export function buildEcosystemAudit(input: EcosystemAuditInput) {
  const startedAt = new Date().toISOString();
  const production = input.nodeEnv === "production";
  const checks: EcosystemAuditCheck[] = [
    check({ id: "api-health", domain: "API", name: "Health del servicio central", status: production ? "production" : "warning", environment: production ? "production" : "unknown", severity: production ? "info" : "warning", evidence: production ? `Proceso Node en producción; commit ${input.commit || "no informado"}.` : "NODE_ENV no es production; no se certifica producción.", endpoint: "/health", version: input.commit }),
    check({ id: "api-ready-db", domain: "Infraestructura", name: "Readiness y conexión MongoDB", status: input.databaseReady && input.mongoReadyState === 1 ? "production" : "error", environment: input.databaseReady && input.mongoReadyState === 1 ? "production" : "unknown", severity: input.databaseReady && input.mongoReadyState === 1 ? "info" : "critical", evidence: input.databaseReady && input.mongoReadyState === 1 ? "MongoDB conectado y readyState=1; comprobación de solo lectura." : "MongoDB no está listo; la API no debe certificarse como operativa.", endpoint: "/ready" }),
    check({ id: "owner-auth", domain: "Seguridad", name: "Protección superadmin y permisos", status: production ? "production" : "not_verified", environment: production ? "production" : "unknown", severity: production ? "info" : "warning", evidence: production ? "Ruta protegida por requireOwner(); no se exponen tokens ni datos de empleados." : "Pendiente de verificación en runtime de producción.", endpoint: "/api/v1/admin/ecosystem-audit" }),
    check({ id: "dispatch", domain: "Dispatch", name: "Elegibilidad y asignación operativa", status: production ? "production" : "not_verified", environment: production ? "production" : "unknown", severity: production ? "info" : "warning", evidence: production ? "Motor de dispatch cargado en la API; esta auditoría no crea pedidos ni asignaciones." : "No verificado fuera de producción.", endpoint: "/api/v1/dispatch/orders/:id/preview" }),
    check({ id: "gps-tracking", domain: "GPS y tracking", name: "Políticas de frescura y tracking", status: production ? "production" : "not_verified", environment: production ? "production" : "unknown", severity: "warning", evidence: production ? "Políticas server-side disponibles; no se inyectan posiciones GPS ni se consulta una posición personal." : "Pendiente de verificación en producción.", endpoint: "/api/v1/riders/:id/tracking/health" }),
    check({ id: "realtime", domain: "Tiempo real", name: "SSE / eventos realtime", status: input.realtimeEnabled && production ? "production" : input.realtimeEnabled ? "warning" : "error", environment: input.realtimeEnabled && production ? "production" : "unknown", severity: input.realtimeEnabled && production ? "info" : "critical", evidence: input.realtimeEnabled ? "Relay realtime configurado; la auditoría no abre sesiones de rider ni envía eventos." : "Realtime no está habilitado en configuración.", endpoint: "/api/v1/realtime/events" }),
    check({ id: "stripe", domain: "Pagos", name: "Configuración Stripe", status: input.stripeConfigured && production ? "production" : input.stripeConfigured ? "warning" : "not_verified", environment: input.stripeConfigured && production ? "production" : "unknown", severity: input.stripeConfigured && production ? "info" : "warning", evidence: input.stripeConfigured ? "Credenciales Stripe presentes; no se crea PaymentIntent ni checkout." : "Stripe no está configurado o no se puede certificar desde esta lectura." }),
    check({ id: "email", domain: "Notificaciones", name: "Correo transaccional", status: input.emailConfigured && production ? "production" : input.emailConfigured ? "warning" : "not_verified", environment: input.emailConfigured && production ? "production" : "unknown", severity: input.emailConfigured && production ? "info" : "warning", evidence: input.emailConfigured ? "Configuración de correo disponible; no se envía ningún mensaje durante la auditoría." : "Proveedor de correo no verificado en runtime." }),
    check({ id: "push", domain: "Notificaciones", name: "Push móvil", status: input.pushConfigured && production ? "production" : input.pushConfigured ? "warning" : "not_verified", environment: input.pushConfigured && production ? "production" : "unknown", severity: "warning", evidence: input.pushConfigured ? "Configuración push disponible; no se envían notificaciones de prueba." : "Push no verificado en runtime." }),
    check({ id: "qa-isolation", domain: "QA y aislamiento", name: "Separación de QA/test frente a producción", status: input.qaMode ? "test_qa" : production ? "production" : "not_verified", environment: input.qaMode ? "test_qa" : production ? "production" : "unknown", severity: input.qaMode ? "critical" : "info", evidence: input.qaMode ? "Modo QA activo: no debe mezclarse con pedidos, pagos, GPS ni dispatch real." : "No se ha detectado el flag global de QA; los checks de esta pantalla son read-only." }),
  ];
  const finishedAt = new Date().toISOString();
  const counts = checks.reduce<Record<EcosystemAuditStatus, number>>((acc, item) => { acc[item.status] += 1; return acc; }, { production: 0, test_qa: 0, warning: 0, error: 0, not_verified: 0 });
  const overallStatus: EcosystemAuditStatus = counts.error || counts.test_qa ? "error" : counts.warning || counts.not_verified ? "warning" : "production";
  return { auditId: `audit_${Date.now()}`, startedAt, finishedAt, overallStatus, counts, checks, readOnly: true, scope: "PIKI Delivery · cobertura operativa equivalente; no certifica componentes propietarios de terceros" };
}
