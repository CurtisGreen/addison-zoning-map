# Site guidelines

Rules for any page, script or content change in this repo.

## Do

1. **Check the facts.** Cite a source and date for every claim, and say what is unverified.
2. **Put the answer first.** Lead with the main fact or action, with details after it.
3. **Write plain, short copy.** Use clear labels, short sentences, and a list or table where it fits.
4. **Make every control keyboard- and screen-reader-friendly.** Use real buttons and links, visible focus, labels, alt text and sufficient contrast.
5. **Give each view a shareable link.** Filters, selections and search live in the URL so refresh, back and sharing work.
6. **Handle every state.** Show loading, empty, error and success states that reflect what actually happened.
7. **Test on real screens.** Check phone width, touch, slow connections and print before calling it done.
8. **Keep the stack small.** Use plain HTML, CSS and JavaScript unless a framework is clearly needed, and pin every dependency version.
9. **Serve readable pages without scripts.** Add real titles, descriptions and headings for search and link previews.
10. **Pick a deliberate look.** Choose a type scale, palette and spacing once, and reuse them everywhere.

## Don't

1. **Don't invent content.** No made-up numbers, features, testimonials or filler marketing copy.
2. **Don't use the default "AI look."** Skip stock gradients, emoji icons and centered hero banners.
3. **Don't hide the main thing.** Don't bury key information behind menus, tabs or extra clicks.
4. **Don't interrupt.** No pop-ups, auto-opening chat or newsletter prompts over the content.
5. **Don't rely on colour alone.** Add a symbol or text for every status or category.
6. **Don't ship secrets or unescaped input.** Keep keys out of client code and escape everything inserted into a page.
7. **Don't pull in unpinned or unchecked packages.** Verify that every library and API call really exists.
8. **Don't reset the user's work.** Keep filters, scroll position and form entries on back and reload.
9. **Don't show success that isn't real.** No "saved" or "sent" message without a confirmed result.
10. **Don't claim it's finished without checking.** Run it, test it, and say what you didn't check.
11. **Don't over-comment.** Comment only a non-obvious reason or a constraint a reader could trip over, never what a line does, why a list is in a given order, or a small edit. Keep comments short, and end a one-sentence comment without a period.

## Design standards

- **Spacing scale:** 0, 1, 4, 8, 12, 16 and 24px. Use only these for margin, padding and gap. Round a value that falls between steps to the nearest one, and up on a tie (6px becomes 8px). Border widths and font sizes are not spacing.
