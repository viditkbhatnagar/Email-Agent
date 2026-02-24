/**
 * Email content preparation module.
 * Converts raw email bodies into clean, structured content for classification.
 * Handles HTML→text conversion, reply chain parsing, signature stripping,
 * and forwarded message detection with budget-aware content assembly.
 */

interface ReplyChainEntry {
  author: string;
  date: string;
  text: string;
}

interface ParsedReplyChain {
  primaryContent: string;
  chain: ReplyChainEntry[];
}

interface ForwardedMessage {
  isForwarded: boolean;
  originalFrom?: string;
  originalDate?: string;
  originalSubject?: string;
  forwardedBody?: string;
  senderComment?: string;
}

export interface PreparedContent {
  text: string;
  charCount: number;
  meta: {
    hadReplyChain: boolean;
    replyChainDepth: number;
    wasForwarded: boolean;
    hadSignature: boolean;
    wasTruncated: boolean;
    derivedFromHtml: boolean;
  };
}

// ---------- HTML to Plain Text ----------

export function htmlToPlainText(html: string): string {
  let text = html;

  // Remove <style> and <script> blocks entirely
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

  // Replace block-level elements with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<\/blockquote>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<hr[^>]*>/gi, "\n---\n");

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&mdash;/g, "—");
  text = text.replace(/&ndash;/g, "–");
  text = text.replace(/&hellip;/g, "…");
  text = text.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code))
  );
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );

  // Collapse excessive whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/^\s+|\s+$/gm, "");

  return text.trim();
}

// ---------- Reply Chain Parsing ----------

// Gmail-style: "On Mon, Jan 1, 2025 at 10:00 AM, John Doe <john@example.com> wrote:"
const GMAIL_QUOTE_PATTERN =
  /^On\s+.{10,80}\s+wrote:\s*$/m;

// Outlook-style: "From: John Doe\nSent: Monday...\nTo: ...\nSubject: ..."
const OUTLOOK_QUOTE_PATTERN =
  /^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}\s*$/m;

const OUTLOOK_HEADER_BLOCK_PATTERN =
  /^From:\s*.+\n(?:Sent|Date):\s*.+\n(?:To:\s*.+\n)?(?:Cc:\s*.+\n)?Subject:\s*.+$/m;

// Standard ">" quoting
const QUOTED_LINE_PATTERN = /^>/;

export function parseReplyChain(text: string): ParsedReplyChain {
  const chain: ReplyChainEntry[] = [];

  // Try Gmail-style quote detection first
  const gmailMatch = text.match(GMAIL_QUOTE_PATTERN);
  if (gmailMatch && gmailMatch.index !== undefined) {
    const primaryContent = text.slice(0, gmailMatch.index).trim();
    let remaining = text.slice(gmailMatch.index);

    // Parse the header line for author and date
    const headerLine = gmailMatch[0];
    const authorDateMatch = headerLine.match(
      /^On\s+(.+?),?\s+(.+?)\s+wrote:/
    );

    // Split remaining by subsequent "On ... wrote:" patterns
    const segments = remaining.split(GMAIL_QUOTE_PATTERN);
    const headers = remaining.match(new RegExp(GMAIL_QUOTE_PATTERN.source, "gm")) || [];

    for (let i = 0; i < headers.length; i++) {
      const hdr = headers[i];
      const adMatch = hdr.match(/^On\s+(.+?),?\s+(.+?)\s+wrote:/);
      const segmentText = (segments[i + 1] || "").trim();

      // Strip leading ">" from quoted lines
      const cleanText = segmentText
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim();

      chain.push({
        author: adMatch ? adMatch[2].trim() : "Unknown",
        date: adMatch ? adMatch[1].trim() : "",
        text: cleanText,
      });
    }

    // If no segments were parsed but we found the header, treat everything after as one entry
    if (chain.length === 0 && authorDateMatch) {
      const quotedText = text
        .slice(gmailMatch.index + gmailMatch[0].length)
        .trim();
      const cleanText = quotedText
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim();
      chain.push({
        author: authorDateMatch[2].trim(),
        date: authorDateMatch[1].trim(),
        text: cleanText,
      });
    }

    return { primaryContent, chain };
  }

  // Try Outlook-style header block detection
  const outlookMatch =
    text.match(OUTLOOK_QUOTE_PATTERN) ||
    text.match(OUTLOOK_HEADER_BLOCK_PATTERN);
  if (outlookMatch && outlookMatch.index !== undefined) {
    const primaryContent = text.slice(0, outlookMatch.index).trim();
    const remaining = text.slice(outlookMatch.index);

    // Parse the From/Sent/To/Subject block
    const fromMatch = remaining.match(/From:\s*(.+)/);
    const dateMatch = remaining.match(/(?:Sent|Date):\s*(.+)/);
    const subjectMatch = remaining.match(/Subject:\s*(.+)/);

    // Find where the actual quoted content starts (after Subject line)
    const subjectEnd = subjectMatch
      ? remaining.indexOf(subjectMatch[0]) + subjectMatch[0].length
      : outlookMatch[0].length;
    const quotedContent = remaining.slice(subjectEnd).trim();

    chain.push({
      author: fromMatch ? fromMatch[1].trim() : "Unknown",
      date: dateMatch ? dateMatch[1].trim() : "",
      text: quotedContent,
    });

    return { primaryContent, chain };
  }

  // Try ">" prefix quoting as a fallback
  const lines = text.split("\n");
  const primaryLines: string[] = [];
  const quotedLines: string[] = [];
  let foundQuote = false;

  for (const line of lines) {
    if (QUOTED_LINE_PATTERN.test(line)) {
      foundQuote = true;
      quotedLines.push(line.replace(/^>\s?/, ""));
    } else if (foundQuote) {
      // After quoted lines, continue adding to quoted block
      quotedLines.push(line);
    } else {
      primaryLines.push(line);
    }
  }

  if (foundQuote && quotedLines.length > 0) {
    chain.push({
      author: "Previous sender",
      date: "",
      text: quotedLines.join("\n").trim(),
    });
    return {
      primaryContent: primaryLines.join("\n").trim(),
      chain,
    };
  }

  // No reply chain detected
  return { primaryContent: text, chain: [] };
}

// ---------- Signature Stripping ----------

const SIGNATURE_PATTERNS = [
  /^-- ?\n/m, // RFC standard sig delimiter
  /^Sent from my (?:iPhone|iPad|Galaxy|Android|Samsung|Pixel|Huawei)/im,
  /^Get Outlook for (?:iOS|Android)/im,
  /^Sent from (?:Yahoo Mail|Mail for Windows)/im,
  /^Sent from (?:Outlook|Thunderbird)/im,
  /^\n*-{2,}\s*\n(?:.*(?:CONFIDENTIAL|DISCLAIMER|PRIVILEGED|NOTICE))/im,
];

export function stripSignature(text: string): {
  content: string;
  signature: string | null;
} {
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      // Only strip if the signature is in the last 40% of the email
      if (match.index > text.length * 0.6) {
        return {
          content: text.slice(0, match.index).trim(),
          signature: text.slice(match.index).trim(),
        };
      }
    }
  }

  return { content: text, signature: null };
}

// ---------- Forwarded Message Detection ----------

const FORWARD_DIVIDERS = [
  /^-{3,}\s*Forwarded message\s*-{3,}/im,
  /^Begin forwarded message:/im,
  /^-{3,}\s*Original Message\s*-{3,}/im,
];

export function parseForwardedMessage(
  text: string,
  subject: string
): ForwardedMessage {
  const isForwardedSubject = /^(Fwd?|Fw):/i.test(subject);

  for (const pattern of FORWARD_DIVIDERS) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      const senderComment = text.slice(0, match.index).trim();
      const remaining = text.slice(match.index + match[0].length).trim();

      // Parse the forwarded header block
      const fromMatch = remaining.match(/From:\s*(.+)/);
      const dateMatch = remaining.match(/(?:Date|Sent):\s*(.+)/);
      const subjectMatch = remaining.match(/Subject:\s*(.+)/);

      // Find where the forwarded body starts
      let bodyStart = 0;
      const lastHeaderMatch = [fromMatch, dateMatch, subjectMatch]
        .filter(Boolean)
        .reduce((max, m) => {
          const end = (m!.index ?? 0) + m![0].length;
          return end > max ? end : max;
        }, 0);
      bodyStart = lastHeaderMatch;

      return {
        isForwarded: true,
        originalFrom: fromMatch ? fromMatch[1].trim() : undefined,
        originalDate: dateMatch ? dateMatch[1].trim() : undefined,
        originalSubject: subjectMatch ? subjectMatch[1].trim() : undefined,
        forwardedBody: remaining.slice(bodyStart).trim(),
        senderComment: senderComment || undefined,
      };
    }
  }

  return {
    isForwarded: isForwardedSubject,
  };
}

// ---------- Main Content Preparation ----------

export function prepareEmailContent(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
  subject: string,
  charBudget: number = 3000
): PreparedContent {
  // Step 1: Get plain text
  let text = bodyText || "";
  let derivedFromHtml = false;
  if (!text && bodyHtml) {
    text = htmlToPlainText(bodyHtml);
    derivedFromHtml = true;
  }

  if (!text) {
    return {
      text: "",
      charCount: 0,
      meta: {
        hadReplyChain: false,
        replyChainDepth: 0,
        wasForwarded: false,
        hadSignature: false,
        wasTruncated: false,
        derivedFromHtml: false,
      },
    };
  }

  // Step 2: Detect forwarded messages
  const fwd = parseForwardedMessage(text, subject);

  // Step 3: Work with the appropriate text
  const workingText = fwd.isForwarded && fwd.senderComment
    ? fwd.senderComment
    : text;

  // Step 4: Strip signature
  const { content: noSig, signature } = stripSignature(workingText);

  // Step 5: Parse reply chain
  const { primaryContent, chain } = parseReplyChain(noSig);

  // Step 6: Assemble within budget using priority allocation
  const primaryBudget = Math.floor(charBudget * 0.6);
  const recentReplyBudget = Math.floor(charBudget * 0.25);
  const olderRepliesBudget = Math.floor(charBudget * 0.15);

  let assembled = "";
  let wasTruncated = false;

  // Primary content gets highest priority
  if (primaryContent.length > primaryBudget) {
    assembled += primaryContent.slice(0, primaryBudget) + "...";
    wasTruncated = true;
  } else {
    assembled += primaryContent;
  }

  // Most recent reply in chain
  if (chain.length > 0) {
    const recent = chain[0];
    const label = recent.author !== "Previous sender"
      ? `\n[Previous reply from ${recent.author}${recent.date ? ` on ${recent.date}` : ""}]:\n`
      : "\n[Previous reply]:\n";
    assembled += label;
    if (recent.text.length > recentReplyBudget) {
      assembled += recent.text.slice(0, recentReplyBudget) + "...";
      wasTruncated = true;
    } else {
      assembled += recent.text;
    }
  }

  // Older chain entries (summarized)
  if (chain.length > 1) {
    assembled += `\n[${chain.length - 1} older message(s) in thread]`;
    const perEntry = Math.floor(olderRepliesBudget / (chain.length - 1));
    for (let i = 1; i < chain.length && assembled.length < charBudget; i++) {
      const entry = chain[i];
      const label = entry.author !== "Previous sender"
        ? `\n  - ${entry.author}: `
        : "\n  - ";
      assembled += label + entry.text.slice(0, Math.min(perEntry, 120));
    }
  }

  // Forwarded content
  if (fwd.isForwarded && fwd.forwardedBody) {
    const fwdLabel =
      `\n[Forwarded from ${fwd.originalFrom || "unknown"}${fwd.originalDate ? ` on ${fwd.originalDate}` : ""}]:\n`;
    assembled += fwdLabel;
    const remaining = charBudget - assembled.length;
    if (remaining > 0) {
      if (fwd.forwardedBody.length > remaining) {
        assembled += fwd.forwardedBody.slice(0, remaining) + "...";
        wasTruncated = true;
      } else {
        assembled += fwd.forwardedBody;
      }
    }
  }

  // Final truncation safety
  if (assembled.length > charBudget) {
    assembled = assembled.slice(0, charBudget) + "...";
    wasTruncated = true;
  }

  return {
    text: assembled,
    charCount: assembled.length,
    meta: {
      hadReplyChain: chain.length > 0,
      replyChainDepth: chain.length,
      wasForwarded: fwd.isForwarded,
      hadSignature: signature !== null,
      wasTruncated,
      derivedFromHtml: derivedFromHtml,
    },
  };
}
