# CoForge

CoForge connects cloud collaboration with code-agent execution on a user's Computer. This glossary fixes the identities and relationships that authorization decisions may refer to.

## Language

**User**:
A CoForge-owned person identity authorizing an interactive management action. External login identities map to a User but are not the User's business identity. A User is not the service identity used by background machine processes.
_Avoid_: Account, operator, Computer user

**Computer**:
The long-lived service identity of one per-user CoForge installation profile registered with one CoForge issuer. Its `name` is the operating-system hostname and its `displayName` is the human-facing Computer Name or pretty hostname used for display and selection. It is distinct from both the User who registered it and the physical hardware.
_Avoid_: Device, daemon, machine credential

**Workspace**:
The top-level logical boundary for collaboration, membership, permissions, conversations, and Agents. A User's first login creates one Workspace of which they are the owner; first login never attaches them to another User's Workspace.
_Avoid_: Organization, Agent workspace, shared default workspace

**WorkspaceMembership**:
The durable association of one User to one Workspace, carrying exactly one role: owner, admin, or member. Owner is assigned at Workspace creation and cannot be transferred, demoted, removed, or left.
_Avoid_: Workspace role assignment without membership

**WorkspaceInvitation**:
A pending offer for an existing User to join a Workspace as admin or member. Owner cannot be invited; acceptance creates WorkspaceMembership.
_Avoid_: Instant add-without-consent membership, email-only invite identity

**Workspace–Computer connection**:
The server-owned association authorizing one Computer to host one Workspace. Its
business identity is the composite `(workspace_id, computer_id)`; any database
surrogate key is internal storage detail. Authority and online state for one
registration never flow through another registration on the same Computer.
_Avoid_: Workspace login, machine assignment

**Workspace session**:
A short-lived connection identity derived from exactly one active Workspace–Computer connection. It cannot confer authority for another Workspace or for User management actions.
_Avoid_: Computer login, global daemon session

A Computer can have multiple Workspace–Computer connections concurrently. Each
connection has an independent credential and Workspace session; adding one does
not replace, revoke, or detach another. Lifecycle scope is one connection or all
local connections, while installation upgrade scope is the whole Computer.

**Agent**:
The logical collaborator belonging to exactly one Workspace, receiving messages, producing responses, and named in server-side authorization and audit records. It is owned by an external User identity.
Its `name` is the unique-per-Workspace username used for @mentions, set at creation and never renamed; its `displayName` is the free-text label shown in conversations, editable at any time and initially equal to `name`.
_Avoid_: Agent process, provider runtime, handle

**DirectConversation**:
A private conversation in one Workspace between exactly one internal User and
one Agent.

**PublicChannel**:
A named conversation whose history is visible to every human member of its
Workspace; joining enables sending. The default `#general` includes all humans
and Agents automatically. Agent notification preferences do not change membership
or access to history.
_Avoid_: Public internet chat, Agent workspace

**Project**:
A named body of work in one Workspace, optionally connected to a GitHub repository,
with multiple discussion groups. A project discussion group is a PublicChannel,
not a Message Thread; it belongs to at most one Project in the same Workspace.

**ConversationMember**:
A conversation subject backed by either a User or an Agent, never both. Its
workspace is the same as the conversation's workspace.

**Message**:
A durable text record in a DirectConversation or PublicChannel, authored by one of
its members or by the system. A system Message is not attributed to a User or Agent.

**Thread**:
A discussion anchored to one top-level Message in a DirectConversation or
PublicChannel. Its identity is that root Message, not a separate conversation.
Replies belong only to that Thread; a reply cannot anchor another Thread. A
Thread exists only once its first reply is sent. Channel members automatically
follow a Thread by replying or being personally mentioned and may unfollow it
without losing read or reply access. All of an Agent's chats and Threads use the
same Agent runtime session.

**Message target**:
The exact destination within a private User–Agent conversation or PublicChannel:
the main chat/channel or a Thread rooted in a particular Message. Reading or
replying to one target does not consume unread messages in another target. A
sender identity is not a Message target and does not change when that sender
replies in a Thread.

**Task**:
A top-level Message tracked as work in its Conversation, with a conversation-local
number, status and at most one responsible ConversationMember. Its discussion
belongs to the Message's Thread; a Task is not an Agent run or a scheduled job.

**Task owner**:
The User or Agent who has claimed responsibility for a Task, distinct from the
Task's message author or the User who owns the Agent.

**Record**:
A Workspace collaboration surface for durable written work outside chat:
weekly-report cycles, member reports, favorites, send templates, and notes.
It is not a Message inbox or an Agent run.
_Avoid_: Message, Task, Agent Activity

**WeeklyReportCycle**:
One ISO week bucket inside a Workspace that groups that week's template and
member reports.
_Avoid_: Calendar month, chat thread

**WeeklyReport**:
One User-authored weekly-report document in a WeeklyReportCycle: either a
Leader weekly parent (format/outline under「成员周报」) or a member document
(personal report or an assignment filled from a Leader parent), carrying
content and a submission status.
_Avoid_: Message body, Task

**Weekly report assignment**:
A member WeeklyReport created when a Leader sends a weekly parent to recipients.
Its title is `{memberDisplayName}的周报 · W{week}`. It stays under「我的周报」
while drafting; after submit it also appears as a child of that parent in
「成员周报」, one per member per parent, overwritten on resend.
_Avoid_: Free-form child page created by Leader “+”

**WeeklyReportTemplate**:
Reusable Workspace send configuration for weekly reports (name, recipients,
frequency, and send time), distinct from a Leader weekly parent document.
_Avoid_: WeeklyReport content, Message template

**RecordComment**:
A comment attached to a Record subject (report or cycle). Authors may be a
User now, or later a system/assistant identity for AI side panels.
_Avoid_: Message, Agent Activity

**Agent status**:
The volatile two-value lease status derived from the local Agent runtime process: `online` while the process is running and `offline` after it exits or is stopped. Lease renewals may replay the same logical status. Records carry daemon instance, client sequence, and the daemon instance start time in `observedAtMs`; same-instance records order by sequence and cross-instance records order by that instance rank. Browser snapshots and live events use the same merge rule.
_Avoid_: starting, ready, degraded, failed

**Agent activity**:
The timeline of runtime lifecycle and provider diagnostics reported by the daemon over its single Workspace Connection WSS. `agent:status` reports only leased `online` or `offline`; `agent:activity` records provider-neutral diagnostics. Provider-specific output remains behind adapters.
_Avoid_: Agent status, runtime state machine

**Agent workspace**:
The durable filesystem working area for one Agent within one Workspace on one Computer. It survives Agent runtime replacement and provider changes, and is not itself a logical Workspace.
_Avoid_: Workspace, repository, provider home, runtime directory

**Agent session**:
The native conversational context used by one Agent, distinct from its runtime
process and from a Workspace session. Replacing the runtime does not by itself
discard this context. A recoverable association is scoped to that Agent, Workspace,
Computer, and provider. It is not a CoForge Message history or a transcript view.

**Restart Agent**:
Stop the Agent runtime and start it again, preferring the same Agent session and
preserving the Agent workspace. An empty session starts fresh silently; a known
missing or safely non-replayable session may start a new session with a new identity
to restore availability. Authentication, network, ambiguous, permission, corruption,
and other I/O failures do not become fresh sessions. Raft `controlAgentRuntime`
capability: any current Workspace member (owner, admin, or member) may perform it,
regardless of who owns the Agent (ADR 0034).

**Session Invalidate**:
The daemon-initiated notice behind a Restart Agent's "known missing or safely
non-replayable session" clause: before (or, for an in-driver replacement, at the
point of learning of) a cold-start retry, the daemon reports the stale native
session id fire-and-forget so the cloud Session association is cleared once,
instead of every later Restart trying the same dead id. It never discards the
Agent workspace and never itself starts a new session; it only clears a stale
association a subsequent Restart Agent then starts fresh from.

**Reset Session**:
Stop the Agent runtime, discard its current session association, and start a new
Agent session in one user operation. Preserve the Agent workspace and old native
session files. Raft `controlAgentRuntime` capability: any current Workspace member
may perform it (ADR 0034).

**Full Reset**:
Stop the Agent runtime, delete all contents of only its Agent workspace, discard
its current session association, and start a new Agent session in one confirmed
user operation. It does not delete cloud Messages, provider home directories,
Global Skills, or another Agent's files. Raft `resetAgentWorkspace` capability:
Workspace owner or admin only, even when the actor owns the Agent (ADR 0034). A
workspace clear that cannot remove every file is non-fatal: the Daemon logs the
failure and the operation still completes, starting a fresh session, instead of
latching the Agent into a state only an explicit reset retry could leave (ADR 0036,
matching Raft, which only logs the same failure). Stopping the Agent runtime first
remains a hard precondition (`confirmed_stop_required`) so a workspace is never
deleted under a live process.

**Agent runtime**:
A short-lived execution and audit identity for one Agent in one Workspace runtime session. Its configuration selects a provider, model, and reasoning behavior; provider-specific adapters translate that configuration into the native runtime settings. It never inherits User or Computer authority.
_Avoid_: Agent token, code-agent installation

**Agent runtime credential**:
Model-provider authorization material assigned to exactly one Agent's runtime
configuration. The Agent owner may set, replace, or remove it; it is not a
User-wide provider credential and is never shared implicitly with another Agent.
_Avoid_: User API key, Computer credential, Agent API key

**WeeklyReportAssistant**:
The User-owned Agent identity used for weekly-report AI within one Workspace.
Each User has at most one WeeklyReportAssistant per Workspace; assistants are
not shared between Users and are not independently managed from Members. Its
Computer and Agent runtime remain the existing configurable Agent resources.
In the collect→synthesize flow ([ADR 0032](docs/adr/0032-weekly-report-collectors-and-collect-run.md)),
this Agent is the synthesizer and side-chat voice only — it does not harvest
another Computer's OS.
_Avoid_: Workspace-wide report Agent, shared report bot, Agent runtime,
WeeklyReportCollector

**WeeklyReportCollector**:
A User-owned Agent bound to exactly one Computer the User owns, dedicated to
harvesting in-window work evidence on that machine into a Collect pack. One
collector slot per owned Computer; never another member's machine. Not the
WeeklyReportAssistant. Not independently managed from Members (same product
pattern as WeeklyReportAssistant). Persisted via `WeeklyReportCollectorBinding`.
See ADR 0032.
_Avoid_: WeeklyReportAssistant, generic Agent, Task, Job

**WeeklyReportCollectorBinding**:
The durable `(workspace, user, computer) → collector Agent` relation for
weekly-report collection. Does not store authoritative scan roots (those stay
Computer-local).
_Avoid_: defaultScanPaths-as-authority, Collect Run

**WeeklyReportCollectRun**:
The platform ledger for one weekly-report harvest cycle: plan confirmation,
parallel per-Computer collection, settle, and synthesis handoff into a
confirmation-backed report suggestion. Narrow to weekly-report collect — not a
Workspace workflow engine, durable command mailbox, or generic job system.
See ADR 0032.
_Avoid_: Task, Job, workflow, Agent Activity completion

**Collect pack**:
The structured Markdown evidence package one WeeklyReportCollector submits for
a Collect Run slot. It is input to synthesis, not the finished member
WeeklyReport body. See ADR 0032.
_Avoid_: WeeklyReport body, Message

**Code Agent installation**:
An external provider executable, currently Codex or Claude Code, discovered from the Daemon's effective executable search path on one Computer. That path includes the service environment and the user's standard local executable directory. Its reported provider and version form a replaceable observation, not a credential or Agent runtime. Built-in Pi is not part of this inventory.
_Avoid_: Agent runtime, Computer registration, built-in Agent

**Code Agent installation visibility**:
Whether a Code Agent installation may be selected by Workspace members other
than the Computer owner. An installation is private by default; its owner may
publish it to the Workspace or make it private again. The owner may always
select it, and publication never grants access outside the Workspace.
_Avoid_: Global runtime, public Computer, installation ownership

**Code Agent model catalog**:
The replaceable model and reasoning selection metadata advertised for one Code Agent provider on one Computer. Pi entries also carry the underlying model provider needed to disambiguate model IDs. A listed model is a supported selection, not proof that the current account is entitled to run it. The catalog validates Agent runtime configuration; it is not a credential or global model registry.

The built-in CoForge catalog is release-generated from the pinned Pi SDK for CoForge's supported single-API-key providers and embedded in `@coforge/agent`/Daemon. External user-installed Pi discovery remains local and dynamic.
_Avoid_: static model list, Agent runtime, provider credential

**Agent API key**:
A server-issued key authorizing one Agent on one Computer to call the Agent message interface. A new launch replaces every active key for the same Agent, and the key never enters the Agent child process.
_Avoid_: Agent token, Agent credential

**AgentProcessManager**:
The daemon-owned component that starts and stops multiple Agent runtimes for the single configured Workspace. Each Agent has one independent runtime OS child process; the MVP has no capacity pool.
_Avoid_: AgentRuntimePool, provider adapter, process slot manager

**Credential Proxy**:
The trusted daemon-owned boundary that authorizes a local Agent runtime to invoke an approved operation without exposing its Agent API key to the Agent process.
_Avoid_: Token endpoint, token store, loopback HTTP proxy

**GitHub Connection**:
A personal Internal User's authorization to a CoForge GitHub App. Repository access is the intersection of that user's GitHub access and the App installation's grants; the connection is not a login identity or a Workspace-wide credential.
_Avoid_: GitHub login, Workspace GitHub account, Project

**Agent GitHub credential**:
The Agent owner's current short-lived GitHub App user token, supplied on demand through the Credential Proxy to Git or `gh` and never stored in the Agent environment. GitHub limits it to the intersection of that user’s access and the App installation grants.
_Avoid_: installation token, Agent App, repository password

**machine_id**:
A stable internal registration identifier for one Computer installation profile. It supports identity reconciliation but is neither a credential, a user-facing Computer name, nor necessarily the primary key of a server-side Computer record.
_Avoid_: Hardware fingerprint, machine secret, Computer token

**Group Memory**:
The Workspace-owned team memory distilled from PublicChannel collaboration and organized as Memory Episodes, Memory Insights, and Interaction Links. DirectConversation content never enters it.
_Avoid_: chat log, channel archive, imported method name

**Memory Episode**:
One admitted, immutable record of a completed slice of PublicChannel collaboration — a Task's discussion window or a channel quiet-window — carrying its participants snapshot and an inferred outcome. It is evidence, not interpretation.
_Avoid_: transcript, log window, Memory Insight, Session commit

**Memory Insight**:
A versioned rule or lesson about how this Workspace's collaboration goes, tied to the Memory Episodes supporting or contradicting it, with a score derived from append-only adjustments. It is team knowledge, not an executable skill.
_Avoid_: LearnedSkill, MEMORY.md note, message

**Interaction Links**:
The lossless, structured collaboration facts extracted from PublicChannel messages: who mentions whom, who replies to what, who delegates what to whom. Together with message nodes and delivery segments they form the interaction record Group Memory is distilled from. They are extracted facts, never semantic guesses.
_Avoid_: interaction log, social graph, inferred relationship

**Provenance edge**:
The recorded source relation across Group Memory's layers: an Episode supporting or contradicting an Insight, an Insight or Episode grounding a Skill Proposal, and a LearnedSkill revision superseding its predecessor. Provenance edges are authoritative records of origin, written when the layer above is created, and they are the paths a Memory Exploration traverses between layers.
_Avoid_: similarity link, derived edge, reference table

**Memory Agent**:
The managed Workspace-scoped Agent that explores Group Memory read-only on every PublicChannel message and on mention, and publishes Memory Offers naming the Agents they may help. Only it may query Group Memory, and it never writes it.
_Avoid_: memory bot, per-user assistant, distiller

**Memory Exploration**:
A bounded read-only query session the Memory Agent opens against Group Memory: retrieve by query, expand from seed citations along Interaction Links and Provenance edges — across the interaction record, Memory Insights, and LearnedSkills — refine, and close with a cited answer.
_Avoid_: unbounded search, training pass, crawl

**Memory Offer**:
A PublicChannel Message from the Memory Agent carrying cited Group Memory content — an Insight, or a LearnedSkill's guidance — to one mentioned Agent, as advice. It offers information; it is not an instruction, a grant of authority, or proof of benefit.
_Avoid_: skill offer, injection, broadcast

**LearnedSkill**:
A Workspace-owned reusable skill distilled from Group Memory's Memory Insights and their supporting evidence. Its artifact is a governed immutable revision of procedural guidance — a decision-branch skill or a stable procedure — identified by lineage, version, and content digest. It is the procedural descendant of memory, not memory itself, and is distinct from provider-native Global Skills and platform-assigned skill packs.
_Avoid_: skill pack, Global Skills, assigned skill, Memory Insight

**Skill Proposal**:
One atomic, immutable proposal to create or revise a single LearnedSkill, grounded in committed Group Memory evidence. A proposal becomes a candidate for delivery, never directly an active skill; its acceptance is decided by later collaboration outcomes, not by its proposer.
_Avoid_: skill patch, freeform edit, auto-accept

**Memory Scenario**:
A scripted PublicChannel collaboration timeline used to test Group Memory: teaching messages with unique markers, fact updates, decoys, and Memory Probes, each carrying expected memory assertions. It is test material over the real pipeline, never production data and never a bypass around the disciplines it exercises.
_Avoid_: benchmark task, fixture chat, Memory Episode

**Memory Probe**:
A message sent into a Memory Scenario to test the Memory Agent's behavior: explicit (an @-ask that must be answered), implicit (related content that should trigger exploration and possibly an offer), or negative (a never-taught topic that must stay silent). A probe's evidence is the server's records — exploration citations, offer deliveries — never the reply text alone.
_Avoid_: test query, judge prompt

**Proposal Ledger**:
The append-only record of every Skill Proposal with its evidence, verdict, and outcome. It preserves rejected and retired proposals so future proposers do not repeat them, and it is required reading before proposing.
_Avoid_: proposal log, skill history table, audit trail of edits
