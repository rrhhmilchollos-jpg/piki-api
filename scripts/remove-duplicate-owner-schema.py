from pathlib import Path
path = Path('/home/ubuntu/piki-api/src/models.ts')
lines = path.read_text().splitlines()
seen = 0
out = []
for line in lines:
    if line.startswith('const employeeAccountSchema = '):
        seen += 1
        if seen == 2:
            continue
    out.append(line)
if seen != 2:
    raise SystemExit(f'expected 2 schema declarations, found {seen}')
path.write_text('\n'.join(out) + '\n')
print('removed duplicate employeeAccountSchema')
