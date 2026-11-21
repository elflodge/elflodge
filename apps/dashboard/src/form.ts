import { ORPCError } from "@orpc/client";
import { isSchemaIssue } from "@orpc/contract";
import { getIssueMessage } from "@orpc/openapi/helpers";
import { useRouter } from "@tanstack/solid-router";
import { PASSWORD_LENGTH } from "contract";
import { action, createEffect, createOptimistic } from "solid-js";

import { hubFailureMessage } from "./api-client.ts";

/** A refusal as a form shows it: the words at each control, by its name, and the alert's. */
type FormRefusal = { fields: Map<string, string>; alert: string | undefined };

/**
 * The refusal `issues` make, located as the hub locates them, each at the control of `controls` that
 * edits its path. One control can edit several input paths. Every unmatched issue stays in the alert.
 */
export function issuesRefusal(
  issues: readonly unknown[],
  controls: Record<string, readonly string[]>,
): FormRefusal {
  const fields = new Map<string, string>();
  const alerts: string[] = [];
  // getIssueMessage returns the first match. Looking up each issue separately also preserves
  // repeated issues at one field and identical messages belonging to different fields.
  for (const issue of issues.filter(isSchemaIssue)) {
    const singleIssueError = { data: { issues: [issue] } };
    const control = Object.entries(controls).find(([, paths]) =>
      paths.some((path) => getIssueMessage(singleIssueError, path) !== undefined),
    );
    if (control) {
      const [name] = control;
      const previous = fields.get(name);
      fields.set(name, previous ? [previous, issue.message].join("\n") : issue.message);
    } else alerts.push(issue.message);
  }
  return { fields, alert: alerts.join("\n") || undefined };
}

/** The refusal `error` makes: its issues at their controls, or the hub's words in the alert. */
export function formRefusal(
  error: unknown,
  controls: Record<string, readonly string[]>,
): FormRefusal {
  if (error instanceof ORPCError && Array.isArray(error.data?.issues))
    return issuesRefusal(error.data.issues, controls);
  return { fields: new Map(), alert: hubFailureMessage(error) };
}

/**
 * `refusal` without the words at the controls `drop` names, which an edit there ends; `refusal`
 * itself when there are none, so what reads it is not told of a change.
 */
export function withoutRefusals<T extends { readonly fields: ReadonlyMap<string, string> }>(
  refusal: T,
  drop: (name: string) => boolean,
): T {
  const kept = [...refusal.fields].filter(([name]) => !drop(name));
  return kept.length === refusal.fields.size ? refusal : { ...refusal, fields: new Map(kept) };
}

/**
 * Before the draft record holding `button` goes: focus moves to the Remove of the row that takes its
 * place, or of the one before, or else to `fallback`.
 */
export function focusNextRemove(button: HTMLElement, fallback: HTMLElement | undefined) {
  const line = button.closest("tr");
  const next = line?.nextElementSibling ?? line?.previousElementSibling;
  (next?.querySelector<HTMLElement>("td.is-act button") ?? fallback)?.focus();
}

/** Restore keyboard focus when it is lost or the focused element is hidden. */
export function focusIfLost(target: HTMLElement | null | undefined) {
  const active = document.activeElement;
  if (active === document.body || !active?.checkVisibility({ visibilityProperty: true }))
    target?.focus();
}

/** Closing the dialog can return focus to its trigger until a later read drops the row. */
export function focusAfterRowDrops(target: HTMLElement, isListed: () => boolean) {
  createEffect(isListed, (listed) => {
    if (!listed) focusIfLost(target);
  });
}

/** Restore lost focus after navigation has rendered the link's replacement. */
export function focusAfterLinkDrops(target: () => HTMLElement | null, onPress?: () => void) {
  const router = useRouter();
  return (event: MouseEvent & { currentTarget: HTMLAnchorElement }) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    const link = event.currentTarget;
    const destination = link.href;
    onPress?.();
    const unsubscribe = router.subscribe("onResolved", () => {
      unsubscribe();
      if (!link.isConnected && location.href === destination) focusIfLost(target());
    });
  };
}

/** Returns true when a field was refused, even if the member moved focus while waiting. */
export function focusRefusedField(form: HTMLFormElement, focusedAtSubmit: Element | null) {
  const refused = form.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!refused) return false;
  if (document.activeElement === focusedAtSubmit) refused.focus();
  else focusIfLost(refused);
  return true;
}

/**
 * Keep the form pending until its submission, including any navigation, settles. `submit` is async,
 * or an async generator, which the action re-enters at each `yield`. Then focus a refused field, or
 * return focus to the control that disabling lost it, unless the member moved on.
 */
export function createFormAction(
  submit: (form: HTMLFormElement) => Promise<void> | AsyncGenerator<void, void, void>,
) {
  const [pending, setPending] = createOptimistic(false);
  const run = action(async function* (form: HTMLFormElement) {
    setPending(true);
    const submission = submit(form);
    if (Symbol.asyncIterator in submission) yield* submission;
    else await submission;
  });
  async function onSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    if (pending()) return;
    const { currentTarget } = event;
    const focused = document.activeElement;
    try {
      await run(currentTarget);
    } finally {
      // The description has rendered with aria-invalid, so a screen reader can announce it on focus.
      if (
        !focusRefusedField(currentTarget, focused) &&
        focused instanceof HTMLElement &&
        "form" in focused &&
        focused.form === currentTarget
      ) {
        // Enter can submit from a field in a fieldset disabled while the action runs.
        focusIfLost(focused);
      }
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
export const NEW_PASSWORD = { minlength: PASSWORD_LENGTH.min } as const;

/**
 * What the hub accepts as a name a person gives: it trims the name and refuses an empty one, so the
 * field refuses a name that is white space alone. The browser shows `title` when it refuses.
 */
export const GIVEN_NAME = {
  // Not `.*`, which stops at a line separator, a character a pasted name can hold.
  pattern: String.raw`[\s\S]*\S[\s\S]*`,
  title: "At least one character that is not a space",
} as const;
