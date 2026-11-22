import type { DialogController, DialogProps } from "@ui-sdk/solid/dialog";

export function dialogAction(props: {
  controller: Pick<DialogController, "isOpen">;
  notice?: () => HTMLElement | undefined;
}) {
  // Escape, Cancel, Keep and an unchanged form return to the trigger even with an old notice.
  let acted = false;
  const finalFocus = () => (acted ? props.notice?.() : undefined);
  const root = {
    // Beside the page root so newly rendered rows inherit its inert state. UI SDK leaves live
    // regions present at opening and their ancestors exposed so they can keep announcing.
    get container() {
      return document.body;
    },
    // A row added beside a live notice can receive a press. Keep the open dialog's record,
    // including any request and refusal for it.
    onPayloadChange(_, details) {
      if (props.controller.isOpen()) details.cancel();
    },
    onOpenChange(open, details) {
      acted = !open && details.reason === "action";
    },
    onOpenChangeComplete(open) {
      // UI SDK focuses without scrolling. The notice can be above a long list.
      if (!open) finalFocus()?.scrollIntoView({ block: "nearest" });
    },
  } satisfies DialogProps;
  return { root, finalFocus };
}

// A withdrawal still disables submit. If its sentence also explains a refusal, only the alert
// should announce it. A withdrawal that arrives during the request shows silently until then.
export function withdrawalMessage(reason: string | undefined, failure: string | undefined) {
  return reason === failure ? undefined : reason;
}
