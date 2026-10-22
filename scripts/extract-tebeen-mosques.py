"""Read only the mosque directory, preserving worksheet order; prepare a first import."""
import argparse
import csv
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import openpyxl


def normalized(value):
    text = str(value).lower().translate(str.maketrans('أإآىةؤئ', 'ااايهوي'))
    return re.sub(r'\s+', ' ', text).strip()


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=Path)
    parser.add_argument('--csv', required=True, type=Path)
    parser.add_argument('--sql', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    workbook = openpyxl.load_workbook(args.workbook, data_only=True, read_only=True)
    sheet = workbook['المساجد']
    source = sheet.iter_rows(max_col=3, values_only=True)
    header = next(source)
    if str(header[1]).strip() != 'المسجد' or str(header[2]).strip() != 'المنطقة':
        raise ValueError('Unexpected mosque directory columns')
    rows, identities = [], set()
    for row_number, values in enumerate(source, 2):
        name = str(values[1]).strip() if values[1] is not None else ''
        area = str(values[2]).strip() if values[2] is not None else ''
        if not name and not area:
            continue
        if not name or not area:
            raise ValueError(f'Missing mosque name or area at row {row_number}')
        identity = (normalized(name), normalized(area))
        if identity in identities:
            raise ValueError(f'Duplicate mosque in the same area at row {row_number}')
        identities.add(identity)
        position = len(rows) + 1
        rows.append((f'M{position:03d}', name, area, position))
    workbook.close()
    if not rows:
        raise ValueError('No mosque records')
    now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    statements = ['-- Tebeen mosque directory only; worksheet row order; no khatibs or assignments.']
    for mosque_id, name, area, position in rows:
        statements.append(
            'INSERT INTO mosques (id,name,mujawra,address,permanent_khatib_id,active,created_at,sort_order) '
            f'VALUES ({sql_text(mosque_id)},{sql_text(name)},{sql_text(area)},\'\',NULL,1,{sql_text(now)},{position});'
        )
    statements.append(
        "INSERT INTO settings(key,value) VALUES ('next_mosque_seq',"
        f"'{len(rows) + 1}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
    )
    sql = '\n'.join(statements) + '\n'
    # Check constraints and exact list order against the real application schema.
    db = sqlite3.connect(':memory:')
    db.executescript((root / 'worker/schema.sql').read_text(encoding='utf-8'))
    db.executescript(sql)
    assert db.execute('SELECT id,name,mujawra,sort_order FROM mosques ORDER BY sort_order').fetchall() == rows
    assert db.execute('SELECT COUNT(*) FROM khatibs').fetchone()[0] == 0
    assert db.execute('SELECT COUNT(*) FROM assignments').fetchone()[0] == 0
    assert db.execute("SELECT value FROM settings WHERE key='next_mosque_seq'").fetchone()[0] == str(len(rows) + 1)
    db.close()
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    with args.csv.open('w', encoding='utf-8', newline='') as output:
        writer = csv.writer(output)
        writer.writerow(['id', 'name', 'mujawra', 'sort_order'])
        writer.writerows(rows)
    args.sql.parent.mkdir(parents=True, exist_ok=True)
    args.sql.write_text(sql, encoding='utf-8')
    print(json.dumps({'mosques': len(rows), 'areas': len(set(row[2] for row in rows)),
                      'first': rows[0][1], 'last': rows[-1][1], 'validation': 'passed'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
