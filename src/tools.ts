/** Custom (non-computer) tools Claude can call alongside computer use. */
import type { Dict } from "./config.js";

export const SEVERITIES = ["blocker", "major", "minor", "cosmetic", "observation"] as const;
export const CATEGORIES = ["functional", "visual", "content", "usability", "performance", "accessibility", "data", "trust"] as const;

export const CUSTOM_TOOLS: Dict[] = [
  {
    "name": "navigate",
    "description": "Load a URL in the browser (like typing in the address bar). Only allowed hosts work. Use sparingly: real customers click through the site.",
    "input_schema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string"
        }
      },
      "required": [
        "url"
      ]
    }
  },
  {
    "name": "page_signals",
    "description": "Technical signals a customer can't see: current URL, title, console errors, failed (4xx/5xx) and slow requests since the last call, unlabelled inputs, images without alt, load time. Call after each major step and whenever something looks wrong.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "read_page_text",
    "description": "Return the visible text of the page. Use it to double-check exact figures, prices or wording you saw in a screenshot, not as a replacement for looking.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "report_finding",
    "description": "Log a defect, risk or notable observation. A screenshot of the current screen is attached automatically, so call this while the problem is on screen.",
    "input_schema": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Short bug title"
        },
        "severity": {
          "type": "string",
          "enum": [
            "blocker",
            "major",
            "minor",
            "cosmetic",
            "observation"
          ]
        },
        "category": {
          "type": "string",
          "enum": [
            "functional",
            "visual",
            "content",
            "usability",
            "performance",
            "accessibility",
            "data",
            "trust"
          ]
        },
        "step": {
          "type": "string",
          "description": "Journey step, e.g. 'vehicle lookup', 'driver details', 'results'"
        },
        "observed": {
          "type": "string"
        },
        "expected": {
          "type": "string"
        },
        "repro_steps": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "persona_impact": {
          "type": "string",
          "description": "How this affects THIS persona"
        },
        "confidence": {
          "type": "number",
          "description": "0-1: how sure you are this is a real defect"
        },
        "suggested_fix": {
          "type": "string",
          "description": "Optional: the likely fix, in a sentence"
        }
      },
      "required": [
        "title",
        "severity",
        "category",
        "step",
        "observed",
        "expected",
        "confidence"
      ]
    }
  },
  {
    "name": "verify_known_finding",
    "description": "Record the result of re-checking a KNOWN finding from the learned brief (by its fingerprint, e.g. K004) when you reach its step. Use this instead of report_finding for known issues.",
    "input_schema": {
      "type": "object",
      "properties": {
        "fingerprint": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "still_present",
            "not_reproduced"
          ]
        },
        "note": {
          "type": "string",
          "description": "What you did and saw"
        }
      },
      "required": [
        "fingerprint",
        "status",
        "note"
      ]
    }
  },
  {
    "name": "finish_mission",
    "description": "End the session. Call exactly once, when the charter is done, you are blocked, a guardrail stopped you, or this persona would give up.",
    "input_schema": {
      "type": "object",
      "properties": {
        "outcome": {
          "type": "string",
          "enum": [
            "completed",
            "blocked",
            "abandoned",
            "stopped_by_guardrail"
          ]
        },
        "summary": {
          "type": "string"
        },
        "furthest_step": {
          "type": "string"
        },
        "would_persona_continue": {
          "type": "boolean",
          "description": "Would this person go on to buy / enquire?"
        },
        "persona_verdict": {
          "type": "string",
          "description": "One or two sentences in the persona's voice"
        },
        "coverage_notes": {
          "type": "string",
          "description": "What you explored and what you did not get to"
        }
      },
      "required": [
        "outcome",
        "summary",
        "furthest_step",
        "would_persona_continue",
        "persona_verdict"
      ]
    }
  }
];
