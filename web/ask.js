// Questions asked inside the page. A framed page's confirm() and prompt() return at once without showing anything.

const $ = (id) => document.getElementById(id);

/** Answers the open question as cancelled. */
let settle = null;

/**
 * Ask in the #ask dialog. Resolves true or false; with `value`, the entered text or null.
 * `ok` names what the confirming button does.
 */
export function ask(message, { ok = 'OK', value } = {}) {
  // A newer question replaces an unanswered one, which counts as cancelled.
  settle?.();
  const dialog = $('ask');
  const input = $('ask-input');
  const confirm = $('ask-ok');
  const cancel = $('ask-cancel');
  const text = value !== undefined;
  $('ask-message').textContent = message;
  confirm.textContent = ok;
  input.hidden = !text;
  input.value = text ? value ?? '' : '';
  return new Promise((resolve) => {
    let answer = text ? null : false;
    const finish = () => {
      if (settle !== finish) return;
      settle = null;
      confirm.removeEventListener('click', accept);
      cancel.removeEventListener('click', finish);
      input.removeEventListener('keydown', enter);
      dialog.removeEventListener('close', closed);
      if (dialog.open) dialog.close();
      resolve(answer);
    };
    const accept = () => {
      answer = text ? input.value : true;
      finish();
    };
    const enter = (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      accept();
    };
    // Escape closes the dialog. A close queued by an earlier question arrives while this one is open.
    const closed = () => { if (!dialog.open) finish(); };
    settle = finish;
    confirm.addEventListener('click', accept);
    cancel.addEventListener('click', finish);
    input.addEventListener('keydown', enter);
    dialog.addEventListener('close', closed);
    dialog.showModal();
    if (text) {
      input.focus();
      input.select();
    } else confirm.focus();
  });
}
