"""Use the existing event schema and DAG checks for the isolated extension."""
import json
from pathlib import Path
import validate_events as events


def main():
    report = events.Report()
    combined = events.load_events(report)
    path = Path(__file__).resolve().parents[1] / 'data/packs/2010-q2-v1/events.json'
    new = json.loads(path.read_text(encoding='utf-8'))['events']
    for card in new:
        card["__source__"] = str(path.relative_to(events.ROOT))
        if not card.get('sources') or not all(s.startswith('https://') for s in card['sources']):
            report.error(f"{card['id']}: missing primary source URL")
        if not '2010-03-31' <= card['date'] <= '2010-06-30':
            report.error(f"{card['id']}: outside chapter/background dates")
        if card['impact'] != {'targets': ['SPX'], 'decayDays': 1}:
            report.error(f"{card['id']}: observed prices must not receive duplicate shocks")
    combined += new
    events.check_fields_and_enums(combined, report)
    ids = events.check_unique_ids(combined, report)
    events.check_references(combined, ids, report)
    events.check_windows(combined, report)
    events.check_acyclic(combined, report)
    events.check_causal_dates(combined, report)
    events.check_tier_ordering(combined, report)
    for error in report.errors:
        print(f'ERROR {error}')
    print(f'2010 Q2: {len(new)} cards; {len(report.errors)} errors; {len(report.warnings)} warnings')
    return bool(report.errors)


if __name__ == '__main__':
    raise SystemExit(main())
