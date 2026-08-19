import yaml from "js-yaml";

export const CLINE_SKILL_NAME_MAX_LENGTH = 64;
export const CLINE_SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const CLINE_SKILL_COMPATIBILITY_MAX_LENGTH = 500;

function skillFrontmatterText(skillText, skillName) {
  if (typeof skillText !== "string") {
    throw new TypeError(`${skillName}/SKILL.md must be UTF-8 text.`);
  }

  const lines = skillText.split(/\r?\n/u);
  if (lines[0] !== "---") {
    throw new Error(`${skillName}/SKILL.md must start with YAML frontmatter.`);
  }

  const closingDelimiterIndex = lines.indexOf("---", 1);
  if (closingDelimiterIndex === -1) {
    throw new Error(
      `${skillName}/SKILL.md must close YAML frontmatter with ---.`,
    );
  }
  return lines.slice(1, closingDelimiterIndex).join("\n");
}

function parseSkillFrontmatter(skillText, skillName) {
  const frontmatterText = skillFrontmatterText(skillText, skillName);
  let frontmatter;
  try {
    // js-yaml v4's load() is the safe loader; the legacy unsafe APIs were
    // removed. Parsed Skill frontmatter is also constrained below to the
    // expected mapping and field types.
    frontmatter = yaml.load(frontmatterText); // nosemgrep: nodejs_scan.javascript-eval-rule-yaml_deserialize
  } catch {
    throw new Error(`${skillName}/SKILL.md frontmatter must be valid YAML.`);
  }

  if (
    !frontmatter ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    throw new Error(
      `${skillName}/SKILL.md frontmatter must be a YAML mapping.`,
    );
  }
  return frontmatter;
}

function requiredSkillFrontmatterField(frontmatter, skillName, field) {
  if (!Object.hasOwn(frontmatter, field)) {
    throw new Error(
      `${skillName}/SKILL.md YAML frontmatter must contain a ${field} field.`,
    );
  }
  return frontmatter[field];
}

function isAsciiLowercaseLetterOrDigit(character) {
  const codePoint = character.codePointAt(0);
  return (
    (codePoint >= 48 && codePoint <= 57) ||
    (codePoint >= 97 && codePoint <= 122)
  );
}

function isValidAgentSkillName(name) {
  const characters = Array.from(name);
  if (
    characters.length === 0 ||
    characters.length > CLINE_SKILL_NAME_MAX_LENGTH ||
    characters[0] === "-" ||
    characters.at(-1) === "-"
  ) {
    return false;
  }

  let previousWasHyphen = false;
  for (const character of characters) {
    if (character === "-") {
      if (previousWasHyphen) return false;
      previousWasHyphen = true;
      continue;
    }
    if (!isAsciiLowercaseLetterOrDigit(character)) return false;
    previousWasHyphen = false;
  }
  return true;
}

function assertAgentSkillName(name, skillName) {
  if (typeof name !== "string") {
    throw new TypeError(`${skillName}/SKILL.md name must be a string.`);
  }
  if (!isValidAgentSkillName(name)) {
    throw new Error(
      `${skillName}/SKILL.md name must be 1-${CLINE_SKILL_NAME_MAX_LENGTH} lowercase letters, numbers, or single hyphens with no leading or trailing hyphen.`,
    );
  }
}

function assertOptionalString(frontmatter, skillName, field, maxLength) {
  if (!Object.hasOwn(frontmatter, field)) return;

  const value = frontmatter[field];
  if (typeof value !== "string") {
    throw new TypeError(`${skillName}/SKILL.md ${field} must be a string.`);
  }
  if (!value.trim()) {
    throw new Error(`${skillName}/SKILL.md ${field} must be non-empty.`);
  }
  if (maxLength && Array.from(value).length > maxLength) {
    throw new Error(
      `${skillName}/SKILL.md ${field} must be at most ${maxLength} characters.`,
    );
  }
}

function assertOptionalMetadata(frontmatter, skillName) {
  if (!Object.hasOwn(frontmatter, "metadata")) return;

  const metadata = frontmatter.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError(`${skillName}/SKILL.md metadata must be a mapping.`);
  }
  for (const value of Object.values(metadata)) {
    if (typeof value !== "string") {
      throw new TypeError(
        `${skillName}/SKILL.md metadata values must be strings.`,
      );
    }
  }
}

function assertOptionalAgentSkillFields(frontmatter, skillName) {
  assertOptionalString(frontmatter, skillName, "license");
  assertOptionalString(
    frontmatter,
    skillName,
    "compatibility",
    CLINE_SKILL_COMPATIBILITY_MAX_LENGTH,
  );
  assertOptionalMetadata(frontmatter, skillName);
  assertOptionalString(frontmatter, skillName, "allowed-tools");
}

export function assertClineSkillFrontmatter(skillText, skillName) {
  if (typeof skillName !== "string" || !skillName) {
    throw new TypeError(
      "Cline Skill directory name must be a non-empty string.",
    );
  }

  const frontmatter = parseSkillFrontmatter(skillText, skillName);
  const name = requiredSkillFrontmatterField(frontmatter, skillName, "name");
  assertAgentSkillName(name, skillName);
  if (name !== skillName) {
    throw new Error(`${skillName}/SKILL.md name must match its directory.`);
  }

  const description = requiredSkillFrontmatterField(
    frontmatter,
    skillName,
    "description",
  );
  if (typeof description !== "string") {
    throw new TypeError(`${skillName}/SKILL.md description must be a string.`);
  }
  if (!description.trim()) {
    throw new Error(
      `${skillName}/SKILL.md must provide a non-empty description.`,
    );
  }
  if (Array.from(description).length > CLINE_SKILL_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `${skillName}/SKILL.md description must be at most ${CLINE_SKILL_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }

  assertOptionalAgentSkillFields(frontmatter, skillName);
  return { name, description };
}
