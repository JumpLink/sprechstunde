#!/usr/bin/env bash
# Extract translatable strings and compile the catalogues.
#
#   dev/i18n.sh extract    refresh po/sprechstunde.pot and merge it into every po/<lang>.po
#   dev/i18n.sh check      fail if the catalogues are stale, fuzzy or incomplete
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
check)
    "$0" extract > /dev/null
    status=0
    # The header carries POT-Creation-Date, which changes on every extract: ignore it.
    if ! git diff --exit-code --ignore-matching-lines='^"POT-Creation-Date:' -- po/; then
        printf 'po/ is stale: run `npm run i18n:extract` and commit the result\n' >&2
        status=1
    fi
    while read -r lang; do
        [ -n "$lang" ] || continue
        for kind in --untranslated --only-fuzzy; do
            # msgattrib always keeps the header entry, so a clean catalogue has exactly one msgid.
            if [ "$(msgattrib "$kind" --no-obsolete "po/$lang.po" | grep -c '^msgid "')" -gt 1 ]; then
                printf 'po/%s.po has %s entries:\n' "$lang" "${kind#--}" >&2
                msgattrib "$kind" --no-obsolete "po/$lang.po" | grep -A1 '^msgid "' >&2
                status=1
            fi
        done
    done < po/LINGUAS
    exit "$status"
    ;;
*)
    printf 'usage: %s <extract|check|compile>\n' "$0" >&2
    exit 2
    ;;
esac
