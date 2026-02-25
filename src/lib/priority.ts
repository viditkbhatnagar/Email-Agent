/**
 * Dynamic effective priority computation.
 *
 * Factors:
 * 1. Deadline proximity (escalation + overdue decay — never fully reverts)
 * 2. Action item sub-deadlines (earliest actionable dueDate)
 * 3. Age-based escalation for unanswered needsReply emails (business-hours aware)
 * 4. Follow-up & escalation signal boosts
 * 5. VIP sender boost
 * 6. Internal/company domain boost
 * 7. Sender velocity anomaly boost
 * 8. Handled bypass (no escalation for handled emails)
 * 9. Provider starred/important boost
 * 10. Thread resolution de-escalation
 * 11. Adaptive reply window from avgResponseTime
 *
 * Never de-escalates below storedPriority from GPT (except thread resolution).
 */

export interface EffectivePriorityOptions {
  needsReply?: boolean;
  handled?: boolean;
  receivedAt?: Date;
  isVipSender?: boolean;
  senderDomain?: string;
  companyDomains?: string[];
  actionItems?: { description: string; dueDate?: string }[];
  isFollowUp?: boolean;
  isEscalation?: boolean;
  senderVelocityAnomaly?: boolean;
  senderRelationship?: string;
  isThreadActive?: boolean;
  confidence?: number;
  isStarred?: boolean;
  avgResponseTime?: number;
  threadResolved?: boolean;
}

/**
 * Count business days (Mon-Fri) between two dates.
 * Excludes weekends but not holidays (acceptable approximation).
 */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let count = 0;
  const current = new Date(from);
  current.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (current < end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

export function computeEffectivePriority(
  storedPriority: number,
  deadline: Date | null,
  options?: EffectivePriorityOptions
): number {
  // Handled emails: no escalation — return stored priority
  if (options?.handled) return storedPriority;

  // Thread resolved: cap at P4 (resolved issues don't need attention)
  if (options?.threadResolved) {
    return Math.max(storedPriority, 4);
  }

  let effectivePriority = storedPriority;
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;

  // --- Compute effective deadline (earliest of main deadline + action item dates) ---
  let effectiveDeadline = deadline;
  if (options?.actionItems?.length) {
    for (const item of options.actionItems) {
      if (item.dueDate) {
        const itemDate = new Date(item.dueDate);
        if (!isNaN(itemDate.getTime())) {
          if (!effectiveDeadline || itemDate < effectiveDeadline) {
            effectiveDeadline = itemDate;
          }
        }
      }
    }
  }

  // --- Deadline proximity escalation with overdue decay ---
  if (effectiveDeadline) {
    const daysUntil = (effectiveDeadline.getTime() - now.getTime()) / msPerDay;

    let deadlinePriority: number;
    if (daysUntil <= 0) {
      // Overdue — decay based on how long overdue, but never fully revert
      const daysOverdue = Math.abs(daysUntil);
      if (daysOverdue <= 7) {
        deadlinePriority = 1; // Still urgent for first week
      } else if (daysOverdue <= 30) {
        deadlinePriority = 2; // Important but fading
      } else if (daysOverdue <= 90) {
        deadlinePriority = 3; // Moderate — probably dealt with
      } else {
        // 3+ months overdue — fully revert to stored priority (no longer relevant)
        deadlinePriority = storedPriority;
      }
    } else if (daysUntil <= 2) {
      deadlinePriority = 1;
    } else if (daysUntil <= 6) {
      deadlinePriority = 2;
    } else if (daysUntil <= 14) {
      deadlinePriority = 3;
    } else {
      deadlinePriority = storedPriority;
    }
    effectivePriority = Math.min(effectivePriority, deadlinePriority);
  }

  // --- Age-based escalation for unanswered emails (business-hours aware) ---
  if (options?.needsReply && !options?.handled && options?.receivedAt) {
    const bizDays = businessDaysBetween(options.receivedAt, now);
    const calendarDays = (now.getTime() - options.receivedAt.getTime()) / msPerDay;
    // Use business days for threshold comparison, but floor at calendar-day check
    // to handle emails that are very old regardless of weekends
    const ageForThreshold = Math.max(bizDays, calendarDays * 0.6);

    // Adaptive reply window: use sender's avgResponseTime if available
    // avgResponseTime is in hours; convert thresholds accordingly
    const avgHours = options?.avgResponseTime;
    let criticalDays: number;
    let importantDays: number;
    let moderateDays: number;

    if (avgHours && avgHours > 0) {
      // Base window = 1.5x their avg response time
      const baseWindowDays = Math.max(1, (avgHours * 1.5) / 24);
      criticalDays = baseWindowDays * 3;   // 3x normal = critical
      importantDays = baseWindowDays;       // Past normal = important
      moderateDays = baseWindowDays * 0.5;  // Half normal = moderate
    } else {
      // Default thresholds (in business days)
      criticalDays = 5;   // ~7 calendar days ≈ 5 business days
      importantDays = 2;   // ~3 calendar days ≈ 2 business days
      moderateDays = 1;
    }

    let agePriority: number;
    if (ageForThreshold > criticalDays) {
      agePriority = 1;
    } else if (ageForThreshold > importantDays) {
      agePriority = 2;
    } else if (ageForThreshold > moderateDays) {
      agePriority = Math.min(storedPriority, 3);
    } else {
      agePriority = storedPriority; // Within normal window = no change
    }
    effectivePriority = Math.min(effectivePriority, agePriority);
  }

  // --- Follow-up boost: escalate by 1 level ---
  if (options?.isFollowUp && !options?.handled) {
    effectivePriority = Math.max(1, Math.min(effectivePriority, storedPriority - 1));
  }

  // --- Escalation boost: escalate by 2 levels ---
  if (options?.isEscalation && !options?.handled) {
    effectivePriority = Math.max(1, Math.min(effectivePriority, storedPriority - 2));
  }

  // --- Sender velocity anomaly: escalate by 1 level ---
  if (options?.senderVelocityAnomaly && !options?.handled) {
    effectivePriority = Math.max(1, Math.min(effectivePriority, storedPriority - 1));
  }

  // --- VIP sender boost: ensure at least P2 ---
  if (options?.isVipSender && effectivePriority > 2) {
    effectivePriority = 2;
  }

  // --- Provider starred/important boost: ensure at least P2 ---
  if (options?.isStarred && effectivePriority > 2) {
    effectivePriority = 2;
  }

  // --- Internal/company domain boost: ensure at least P3 (supports subdomains) ---
  if (options?.senderDomain && options?.companyDomains?.length) {
    const sd = options.senderDomain.toLowerCase();
    const isInternal = options.companyDomains.some((d) => {
      const dl = d.toLowerCase();
      return sd === dl || sd.endsWith("." + dl);
    });
    if (isInternal && effectivePriority > 3) {
      effectivePriority = 3;
    }
  }

  // --- Sender relationship adjustments ---
  if (options?.senderRelationship) {
    const rel = options.senderRelationship.toLowerCase();
    // Automated senders: cap at P4 (deadline/VIP escalation can still override)
    if (rel === "automated" && effectivePriority > 4) {
      effectivePriority = 4;
    }
    // Known colleagues/managers: ensure at least P3
    if ((rel === "colleague" || rel === "manager") && effectivePriority > 3) {
      effectivePriority = 3;
    }
  }

  // --- Active thread with pending reply: mild escalation ---
  if (options?.isThreadActive && options?.needsReply && !options?.handled) {
    effectivePriority = Math.max(1, Math.min(effectivePriority, storedPriority - 1));
  }

  // --- Confidence-based cap: low-confidence P1/P2 → cap at P3 ---
  // Only cap if deadline isn't the reason for escalation (deadline-driven is reliable)
  if (
    options?.confidence != null &&
    options.confidence < 0.6 &&
    effectivePriority <= 2
  ) {
    const hasDeadlineEscalation = !!effectiveDeadline;
    if (!hasDeadlineEscalation) {
      effectivePriority = Math.max(effectivePriority, 3);
    }
  }

  return effectivePriority;
}

/**
 * Explain why effective priority differs from stored priority.
 * Lightweight — call only for detail view, not list view.
 */
export function computeEscalationReasons(
  storedPriority: number,
  effectivePriority: number,
  deadline: Date | null,
  options?: EffectivePriorityOptions
): string[] {
  if (effectivePriority >= storedPriority && !options?.threadResolved) return [];
  const reasons: string[] = [];
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;

  if (options?.threadResolved) {
    reasons.push("Thread resolved — de-escalated");
  }

  // Check deadline
  let effectiveDeadline = deadline;
  if (options?.actionItems?.length) {
    for (const item of options.actionItems) {
      if (item.dueDate) {
        const d = new Date(item.dueDate);
        if (!isNaN(d.getTime()) && (!effectiveDeadline || d < effectiveDeadline)) {
          effectiveDeadline = d;
        }
      }
    }
  }
  if (effectiveDeadline) {
    const daysUntil = (effectiveDeadline.getTime() - now.getTime()) / msPerDay;
    if (daysUntil <= 0) {
      reasons.push(`Overdue by ${Math.ceil(Math.abs(daysUntil))} days`);
    } else if (daysUntil <= 14) {
      reasons.push(`Deadline in ${Math.ceil(daysUntil)} days`);
    }
  }

  if (options?.needsReply && options?.receivedAt) {
    const bizDays = businessDaysBetween(options.receivedAt, now);
    if (bizDays > 1) {
      reasons.push(`Unanswered for ${bizDays} business days`);
    }
  }
  if (options?.isFollowUp) reasons.push("Follow-up detected");
  if (options?.isEscalation) reasons.push("Escalation detected");
  if (options?.senderVelocityAnomaly) reasons.push("Unusual sender activity");
  if (options?.isVipSender) reasons.push("VIP sender");
  if (options?.isStarred) reasons.push("Starred/important in email client");
  if (options?.isThreadActive && options?.needsReply) reasons.push("Active thread needs reply");

  return reasons;
}

/**
 * Check if an email matches a set of requested effective priorities.
 */
export function matchesEffectivePriority(
  storedPriority: number,
  deadline: Date | null,
  requestedPriorities: number[],
  options?: EffectivePriorityOptions
): boolean {
  const effective = computeEffectivePriority(storedPriority, deadline, options);
  return requestedPriorities.includes(effective);
}

/**
 * Detect follow-up and escalation signals from email text.
 * Lightweight — safe to call at query time.
 */
const FOLLOW_UP_RE =
  /\b(?:follow(?:ing)?\s*up|checking\s+in|bump|circling\s+back|gentle\s+reminder|any\s+update|haven'?t\s+heard\s+back|friendly\s+reminder|still\s+(?:waiting|pending|need))\b/i;
const ESCALATION_RE =
  /\b(?:urgent|time[\s-]sensitive|asap|escalat(?:ing|ion|ed)|immediately|critical|blocking|overdue|final\s+(?:notice|reminder|warning)|action\s+required)\b/i;

/**
 * Resolution keywords — indicates a thread issue was resolved.
 */
const RESOLUTION_RE =
  /\b(?:resolved|never\s+mind|done|taken\s+care\s+of|all\s+set|approved|cancelled|no\s+longer\s+needed|withdrawn|closed|completed|sorted|fixed|handled)\b/i;

/**
 * Strip quoted reply lines from body preview to avoid false positives.
 * Removes lines starting with ">" and "On ... wrote:" attribution lines.
 */
function stripQuotedText(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(">")) return false;
      if (/^On .+ wrote:$/i.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

export function detectFollowUp(
  subject: string,
  bodyPreview?: string
): { isFollowUp: boolean; isEscalation: boolean } {
  const cleanBody = bodyPreview ? stripQuotedText(bodyPreview) : "";
  const text = `${subject} ${cleanBody}`;
  return {
    isFollowUp: FOLLOW_UP_RE.test(text),
    isEscalation: ESCALATION_RE.test(text),
  };
}

/**
 * Detect if the latest message in a thread resolves the issue.
 */
export function detectResolution(
  subject: string,
  bodyPreview?: string
): boolean {
  const cleanBody = bodyPreview ? stripQuotedText(bodyPreview) : "";
  const text = `${subject} ${cleanBody}`;
  return RESOLUTION_RE.test(text);
}
