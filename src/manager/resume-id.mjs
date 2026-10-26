const MAX_RESUME_ID = 200;

/** A session id or name to resume: one printable line, or null when absent. */
export function cleanResumeId(resume) {
  if (resume === undefined || resume === null) return null;
  const id = String(resume).trim();
  if (!id || id.length > MAX_RESUME_ID || /\p{Cc}/u.test(id) || id.startsWith('-')) {
    throw Object.assign(new Error(`resume must be a printable id of at most ${MAX_RESUME_ID} characters that does not start with "-"`), { status: 400, code: 'bad_resume' });
  }
  return id;
}
