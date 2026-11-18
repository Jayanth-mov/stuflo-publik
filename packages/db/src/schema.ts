import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

export interface EncryptionEnvelopeRecord {
  v: string;
  kid: string;
  iv: string;
  ciphertext: string;
}

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const students = pgTable(
  'students',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    studentKey: text('student_key').notNull(),
    timeZone: text('time_zone').notNull().default('America/Chicago'),
    plan: text('plan').notNull().default('free'),
    status: text('status').notNull().default('active'),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('students_user_id_unique').on(table.userId),
    uniqueIndex('students_student_key_unique').on(table.studentKey),
    index('students_status_idx').on(table.status),
  ],
);

export const studentProfiles = pgTable('student_profiles', {
  studentId: uuid('student_id')
    .primaryKey()
    .references(() => students.id, { onDelete: 'cascade' }),
  preferredName: text('preferred_name'),
  communicationStyle: text('communication_style').notNull().default('balanced'),
  responseVerbosity: text('response_verbosity').notNull().default('balanced'),
  learningGoals: jsonb('learning_goals').$type<string[]>().notNull().default([]),
  studyPreferences: jsonb('study_preferences')
    .$type<Record<string, string | number | boolean | string[]>>()
    .notNull()
    .default({}),
  memorySummary: text('memory_summary').notNull().default(''),
  createdAt,
  updatedAt,
});

export const studentMemories = pgTable(
  'student_memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    category: text('category').notNull().default('preference'),
    content: text('content').notNull(),
    source: text('source').notNull().default('student'),
    status: text('status').notNull().default('active'),
    pinned: boolean('pinned').notNull().default(false),
    createdAt,
    updatedAt,
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    index('student_memories_student_status_idx').on(table.studentId, table.status),
    index('student_memories_student_updated_idx').on(table.studentId, table.updatedAt),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionTokenHash: text('session_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('auth_sessions_token_hash_unique').on(table.sessionTokenHash),
    index('auth_sessions_user_id_idx').on(table.userId),
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    uniqueIndex('verification_tokens_token_hash_unique').on(table.tokenHash),
    index('verification_tokens_email_idx').on(table.email),
    index('verification_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

export const emailChallenges = pgTable('email_challenges', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt,
}, (table) => [index('email_challenges_email_created_idx').on(table.email, table.createdAt)]);

export const loginIdentities = pgTable('login_identities', {
  provider: text('provider').notNull(),
  subject: text('subject').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt,
}, (table) => [
  primaryKey({ columns: [table.provider, table.subject] }),
  uniqueIndex('login_identities_user_provider_unique').on(table.userId, table.provider),
]);

export const canvasConnections = pgTable(
  'canvas_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    canvasHost: text('canvas_host').notNull(),
    encryptedCookies: jsonb('encrypted_cookies').$type<EncryptionEnvelopeRecord>().notNull(),
    encryptionVersion: text('encryption_version').notNull(),
    cookiesUpdatedAt: timestamp('cookies_updated_at', { withTimezone: true }).notNull(),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    status: text('status').notNull().default('connected'),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('canvas_connections_student_id_unique').on(table.studentId),
    index('canvas_connections_status_idx').on(table.status),
  ],
);

export const canvasInitializationRuns = pgTable(
  'canvas_initialization_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    canvasHost: text('canvas_host').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('queued'),
    coursesTotal: integer('courses_total').notNull().default(0),
    coursesCompleted: integer('courses_completed').notNull().default(0),
    syllabiFound: integer('syllabi_found').notNull().default(0),
    syllabiStored: integer('syllabi_stored').notNull().default(0),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index('canvas_initialization_runs_student_created_idx').on(table.studentId, table.createdAt),
    index('canvas_initialization_runs_status_idx').on(table.status),
  ],
);

export const canvasCourseSnapshots = pgTable(
  'canvas_course_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    canvasHost: text('canvas_host').notNull(),
    courseId: text('course_id').notNull(),
    courseName: text('course_name').notNull(),
    courseCode: text('course_code'),
    termName: text('term_name'),
    courseUrl: text('course_url').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    syllabusStatus: text('syllabus_status').notNull().default('not_scanned'),
    syllabusSourceUrl: text('syllabus_source_url'),
    syllabusAttachmentIds: jsonb('syllabus_attachment_ids').$type<string[]>().notNull().default([]),
    externalSystems: jsonb('external_systems')
      .$type<Array<{ name: string; url: string; kind: string; source: string }>>()
      .notNull()
      .default([]),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default({}),
    initializedAt: timestamp('initialized_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('canvas_course_snapshots_student_course_unique').on(
      table.studentId,
      table.canvasHost,
      table.courseId,
    ),
    index('canvas_course_snapshots_student_active_idx').on(table.studentId, table.isActive),
    index('canvas_course_snapshots_student_term_idx').on(table.studentId, table.termName),
  ],
);

export const googleConnections = pgTable(
  'google_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    googleEmail: text('google_email').notNull(),
    encryptedTokens: jsonb('encrypted_tokens').$type<EncryptionEnvelopeRecord>().notNull(),
    encryptionVersion: text('encryption_version').notNull(),
    scopes: text('scopes').array().notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    status: text('status').notNull().default('connected'),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('google_connections_student_id_unique').on(table.studentId),
    index('google_connections_status_idx').on(table.status),
  ],
);

export const usageSettings = pgTable('usage_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt,
});

export const creditGrants = pgTable(
  'credit_grants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    idempotencyKey: text('idempotency_key'),
    creditsGranted: numeric('credits_granted', { precision: 18, scale: 6 }).notNull(),
    creditsRemaining: numeric('credits_remaining', { precision: 18, scale: 6 }).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    createdAt,
  },
  (table) => [
    index('credit_grants_student_fifo_idx').on(table.studentId, table.createdAt),
    uniqueIndex('credit_grants_idempotency_key_unique').on(table.idempotencyKey),
  ],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    provider: text('provider'),
    model: text('model'),
    operation: text('operation').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    estimatedProviderCostUsd: numeric('estimated_provider_cost_usd', { precision: 18, scale: 8 }),
    creditValueUsd: numeric('credit_value_usd', { precision: 18, scale: 8 }),
    creditsCharged: numeric('credits_charged', { precision: 18, scale: 6 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (table) => [
    index('usage_events_student_created_idx').on(table.studentId, table.createdAt),
    index('usage_events_operation_idx').on(table.operation),
  ],
);

export const stripeCustomers = pgTable('stripe_customers', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  createdAt,
  updatedAt,
});

export const stripeSubscriptions = pgTable(
  'stripe_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    status: text('status').notNull(),
    priceId: text('price_id').notNull(),
    plan: text('plan').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('stripe_subscriptions_stripe_id_unique').on(table.stripeSubscriptionId),
    index('stripe_subscriptions_user_id_idx').on(table.userId),
    index('stripe_subscriptions_status_idx').on(table.status),
  ],
);

export const stripeEvents = pgTable('stripe_events', {
  stripeEventId: text('stripe_event_id').primaryKey(),
  type: text('type').notNull(),
  livemode: boolean('livemode').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
});

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('stored'),
    source: text('source').notNull().default('upload'),
    purpose: text('purpose').notNull().default('attachment'),
    sourceKey: text('source_key'),
    sourceUrl: text('source_url'),
    canvasHost: text('canvas_host'),
    courseId: text('course_id'),
    courseName: text('course_name'),
    createdAt,
    updatedAt,
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('attachments_r2_key_unique').on(table.r2Key),
    uniqueIndex('attachments_student_source_key_unique').on(table.studentId, table.sourceKey),
    index('attachments_student_created_idx').on(table.studentId, table.createdAt),
    index('attachments_student_source_idx').on(table.studentId, table.source),
    index('attachments_expires_at_idx').on(table.expiresAt),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (table) => [index('audit_logs_student_created_idx').on(table.studentId, table.createdAt)],
);

export const operationalAlerts = pgTable(
  'operational_alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dedupeKey: text('dedupe_key').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    status: text('status').notNull().default('open'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    firstTriggeredAt: timestamp('first_triggered_at', { withTimezone: true }).defaultNow().notNull(),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('operational_alerts_dedupe_key_unique').on(table.dedupeKey),
    index('operational_alerts_status_triggered_idx').on(table.status, table.lastTriggeredAt),
  ],
);

export const creditGrantSpends = pgTable(
  'credit_grant_spends',
  {
    usageEventId: uuid('usage_event_id')
      .notNull()
      .references(() => usageEvents.id, { onDelete: 'cascade' }),
    creditGrantId: uuid('credit_grant_id')
      .notNull()
      .references(() => creditGrants.id, { onDelete: 'restrict' }),
    creditsSpent: numeric('credits_spent', { precision: 18, scale: 6 }).notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.usageEventId, table.creditGrantId] }),
    index('credit_grant_spends_grant_id_idx').on(table.creditGrantId),
  ],
);
