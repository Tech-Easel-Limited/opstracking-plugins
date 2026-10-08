/**
 * The response shapes this server reads, as the API sends them.
 *
 * Mirrors the zod schemas in frontend/src/services/*.ts (the client's own
 * contract with the API). Fields are optional wherever the API may omit or
 * null them, so a newer server adding fields never breaks a tool.
 */

export type Ref = { id: string; name?: string; email?: string };

export type Page<T> = { rows: T[]; total: number; page?: number; size?: number };

export type PermGrant = { cat: string; enabled: boolean; acts: string[] | null; extras?: string[] | null; scope?: string };

export type MeWorkspace = {
  id: string;
  name: string;
  role: { id: string; key?: string; name: string };
  perms: PermGrant[] | null;
  granted?: number;
  total?: number;
  memberType?: string;
  tracksTime?: boolean;
};

/**
 * The token a request came with (docs/plans/MCP-EXPANSION.md §8.3). Absent
 * for a browser session — and on an OpsTracking that predates scoped tokens,
 * which is how the server tells the two apart (src/access.ts).
 */
export type MeToken = {
  id: string;
  name?: string;
  scopes: string[] | null;
  expiresAt?: string | null;
};

export type Me = {
  user: { id: string; username: string };
  profile: { firstName?: string; lastName?: string } | null;
  currentOrg: { id: string; name: string; slug: string } | null;
  orgs: Array<{ id: string; name: string; slug: string; memberId?: string; orgRole?: number; status?: string }>;
  workspaces: MeWorkspace[] | null;
  token?: MeToken | null;
};

export type Project = {
  id: string;
  name: string;
  key?: string;
  desc?: string;
  status?: string;
  client?: Ref | null;
  manager?: Ref | null;
  lead?: Ref | null;
  billing?: string;
  currency?: string;
  start?: string | null;
  end?: string | null;
  members?: number;
  tasksTotal?: number;
  tasksDone?: number;
  progress?: number;
  loggedMinutes?: number | null;
};

export type ProjectMember = {
  id: string;
  name: string;
  email?: string;
  role?: string;
  billable?: boolean;
  isClient?: boolean;
};

export type ProjectDetail = Project & { memberList?: ProjectMember[] };

export type BoardColumn = {
  id: string;
  name: string;
  position?: number;
  wipLimit?: number | null;
  tasks?: number;
  wipExceeded?: boolean;
  done?: boolean;
};

export type Task = {
  id: string;
  title: string;
  desc?: string;
  project?: Ref | null;
  column?: Ref | null;
  priority?: string;
  type?: string;
  start?: string | null;
  due?: string | null;
  overdue?: boolean;
  estimateMinutes?: number | null;
  tags?: string[] | null;
  assignees?: Ref[] | null;
  subtasksDone?: number;
  subtasksTotal?: number;
  kind?: string;
  number?: number;
  key?: string;
  parent?: { id: string; title?: string } | null;
  comments?: number;
  done?: boolean;
  completedAt?: string | null;
  trackedMinutes?: number | null;
};

/**
 * A milestone note the GitHub integration writes into a task's thread — a
 * branch created, a PR opened or merged, a release shipped, a move. Nobody
 * authored it, so `author` is null on such a comment.
 */
export type CommentSystem = {
  source: string;
  event: string;
  label: string;
  url: string;
};

export type TaskComment = {
  id: string;
  /** Null on a system note (see `system`). */
  author: Ref | null;
  system?: CommentSystem | null;
  body: string;
  createdAt?: string;
  editedAt?: string | null;
  parentId?: string;
};

export type TaskDetail = Task & {
  subtaskList?: Task[] | null;
  commentList?: TaskComment[] | null;
  warning?: { code?: string; message?: string } | null;
};

export type Contact = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  title?: string;
  isPrimary?: boolean;
  status?: string;
  /** The portal identity this person signs in as; empty until they have one. */
  orgMemberId?: string;
};

export type Client = {
  id: string;
  name: string;
  short?: string;
  industry?: string;
  country?: string;
  currency?: string;
  terms?: string;
  projects?: number;
  contacts?: number;
  status?: string;
  contact?: { name?: string; email?: string } | null;
};

export type TimeEntry = {
  id: string;
  projectId?: string;
  project?: string;
  taskId?: string | null;
  task?: string;
  date: string;
  mode?: string;
  billable?: boolean;
  minutes: number;
  label?: string;
  notes?: string;
  submitted?: boolean;
  submissionStatus?: string;
};

export type Invoice = {
  id: string;
  number?: string;
  client?: Ref | null;
  projects?: Ref[] | null;
  source?: string;
  status?: string;
  label?: string;
  issued?: string | null;
  due?: string | null;
  hours?: string;
  subtotal?: string;
  amount?: string;
  currency?: string;
};

export type InvoiceItem = { name?: string; sub?: string; hours?: string; rate?: string; amount?: string };

export type InvoiceDetail = Invoice & {
  items?: InvoiceItem[] | null;
  billTo?: string;
  notes?: string;
  adjustment?: string;
  discount?: string;
  tax?: string;
  from?: string;
  to?: string;
  payOnline?: boolean;
  payUrl?: string;
  template?: string;
  includeInvoiced?: boolean;
  prorateFixed?: boolean;
  rebillReason?: string;
};

export type InvoicePreview = {
  items?: InvoiceItem[] | null;
  subtotal?: string;
  adjustment?: string;
  discount?: string;
  taxed?: string;
  total?: string;
  hours?: string;
  currency?: string;
  pulledEntries?: number;
  excluded?: Record<string, unknown[] | null> | null;
  issues?: string[] | null;
};

export type Employee = {
  id: string;
  name: string;
  email?: string;
  designation?: string;
  department?: string;
  team?: string;
  role?: string;
  status?: string;
  projects?: number;
};

export type ClientDetail = Client & {
  companyEmail?: string;
  companyPhone?: string;
  site?: string;
  address?: string;
  notes?: string;
  legalName?: string;
  billingEmail?: string;
  timezone?: string;
  taxId?: string;
  contactList?: Contact[] | null;
  projectList?: Ref[] | null;
};

export type Department = {
  id: string;
  name: string;
  desc?: string;
  head?: Ref | null;
  members?: number;
  projects?: number;
  status?: string;
};

export type Team = {
  id: string;
  name: string;
  department?: Ref | null;
  lead?: Ref | null;
  members?: number;
  projects?: number;
  status?: string;
};

/** Departments and teams answer the whole list at once, not a page. */
export type List<T> = { rows: T[] | null; total?: number };

export type Asset = {
  id: string;
  number?: string;
  label?: string;
  brand?: string;
  model?: string;
  type?: string;
  serial?: string;
  specsSummary?: string;
  desc?: string;
  cost?: string | null;
  purchased?: string | null;
  warranty?: string | null;
  department?: Ref | null;
  holder?: Ref | null;
  status?: string;
  archived?: boolean;
};

/** The one running clock a person may have (GET/POST /timesheets/timer). */
export type Timer = {
  id: string;
  projectId?: string;
  project?: string;
  taskId?: string | null;
  task?: string;
  billable?: boolean;
  startedAt?: string;
  stopAt?: string;
  workedOn?: string;
};

/**
 * Stopping a clock always hands the minutes back: a refused write is a 200
 * with `refusal` set, so the time is never lost with an error.
 */
export type TimerStop = {
  minutes: number;
  date?: string;
  discarded?: boolean;
  entry?: TimeEntry | null;
  refusal?: { code?: string; message?: string } | null;
};

export type BulkResult = { affected: number; warning?: { code?: string; message?: string } | null };

/** A workspace role, as the roles list and the invite picker name it. */
export type Role = { id: string; key?: string; name: string; external?: boolean };

/**
 * An act filed for the person's approval in the app (§8.3). `display` is
 * computed by OpsTracking from the stored payload, never from the agent's own
 * words; `result` is what the replayed route answered once it was approved.
 * `status` is one of pending, executing, approved, declined, expired, failed;
 * `approvalUrl` carries the workspace (`…/approvals/agent/<uuid>?ws=<uuid>`).
 */
export type AgentRequest = {
  id: string;
  kind: string;
  status: string;
  summary?: string;
  display?: Array<{ label: string; value: string }> | null;
  approvalUrl?: string;
  createdAt?: string;
  expiresAt?: string;
  decidedAt?: string | null;
  result?: { status?: number; code?: string; message?: string } | null;
  needsPassword?: boolean;
  /** The connection that filed it ("Claude on wali-mbp"); null once that token is gone. */
  tokenName?: string | null;
};
