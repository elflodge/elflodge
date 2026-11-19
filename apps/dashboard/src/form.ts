import { action, createEffect, createOptimistic } from "solid-js";

/** Restore keyboard focus only if the member has no focused control. */
export function focusIfLost(target: HTMLElement | null | undefined) {
  if (!document.activeElement || document.activeElement === document.body) target?.focus();
}

/** Closing the dialog can return focus to its trigger until a later read drops the row. */
export function focusAfterRowDrops(target: HTMLElement, isListed: () => boolean) {
  createEffect(isListed, (listed) => {
    if (!listed) focusIfLost(target);
  });
}

/** Keep the form pending until its submission, including any navigation, settles. */
export function createFormAction(submit: (form: HTMLFormElement) => Promise<void>) {
  const [pending, setPending] = createOptimistic(false);
  const run = action(function* (form: HTMLFormElement) {
    setPending(true);
    yield submit(form);
  });
  async function onSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    if (pending()) return;
    const { submitter, currentTarget } = event;
    const restoreFocus = submitter === document.activeElement;
    try {
      await run(currentTarget);
    } finally {
      // Disabling the focused button sends focus to the body. If the member or the form has
      // since focused another control (such as a refused field), keep that position.
      if (restoreFocus) focusIfLost(submitter);
    }
  }
  return { pending, onSubmit };
}

/** The text a form's field `name` holds when submitted, or "" when it has none. */
export function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * The shortest password the hub accepts, Better Auth's default, which the hub keeps. The longest,
 * 128, is left to the hub to refuse: `maxlength` would cut a longer one without saying so, and the
 * password set would not be the one typed or pasted.
 */
export const NEW_PASSWORD = { minlength: 8 } as const;

/**
 * What the hub accepts as a name a person gives: it trims the name and refuses an empty one, so the
 * field refuses a name that is white space alone. The browser shows `title` when it refuses.
 */
export const GIVEN_NAME = {
  // Not `.*`, which stops at a line separator, a character a pasted name can hold.
  pattern: String.raw`[\s\S]*\S[\s\S]*`,
  title: "At least one character that is not a space",
} as const;
