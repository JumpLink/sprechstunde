#!/usr/bin/env bash
# Extract translatable strings and compile the catalogues.
#
#   dev/i18n.sh extract    refresh po/sprechstunde.pot and merge it into every po/<lang>.po
#   dev/i18n.sh compile    build dist/locale/<lang>/LC_MESSAGES/sprechstunde.mo
#
# Same approach as the other apps in this workspace: English msgids in the source, `_()` and `_n()`
# as the markers, one German catalogue from the first user-facing string on.
set -euo pipefail

cd "$(dirname "$0")/.."
DOMAIN='sprechstunde'
POT="po/$DOMAIN.pot"

case "${1:-}" in
extract)
    find src -type f -name '*.ts' -not -name '*.test.ts' | sort > po/POTFILES.in
    # `--from-code` matters: without it xgettext refuses any non-ASCII msgid.
    xgettext \
        --files-from=po/POTFILES.in \
        --output="$POT" \
        --from-code=UTF-8 \
        --language=JavaScript \
        --keyword=_ \
        --keyword=_n:1,2 \
        --add-comments=TRANSLATORS \
        --package-name="$DOMAIN"
    while read -r lang; do
        [ -n "$lang" ] || continue
        if [ ! -f "po/$lang.po" ]; then
            msginit --no-translator --input="$POT" --locale="$lang" --output-file="po/$lang.po"
        fi
        # `--previous` keeps the old msgid next to a fuzzy match, which makes a reworded string
        # reviewable instead of guesswork.
        msgmerge --update --previous --backup=none "po/$lang.po" "$POT"
    done < po/LINGUAS
    printf 'extracted %s msgids\n' "$(grep -c '^msgid "' "$POT")"
    ;;
compile)
    while read -r lang; do
        [ -n "$lang" ] || continue
        out="dist/locale/$lang/LC_MESSAGES"
        mkdir -p "$out"
        # `--check` refuses a catalogue whose format specifiers do not match its msgid.
        msgfmt --check --output-file="$out/$DOMAIN.mo" "po/$lang.po"
        printf 'compiled %-6s -> %s\n' "$lang" "$out/$DOMAIN.mo"
    done < po/LINGUAS
    ;;
*)
    printf 'usage: %s <extract|compile>\n' "$0" >&2
    exit 2
    ;;
esac
