"""
fetch_funds.py
מושך תשואות קרנות נאמנות מאתר מאיה (TASE) ומעדכן את eden_funds.json.
שומר על מבנה ה-JSON הקיים ועל דמי הניהול שהוזנו ידנית.
הרץ פעם בשבוע (ראה הוראות בתחתית).
"""

import json, time, sys, re
from pathlib import Path
from datetime import datetime

# ── תלויות: pip install selenium webdriver-manager ──
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from webdriver_manager.chrome import ChromeDriverManager
except ImportError:
    print("ERROR: חסרות תלויות. הרץ:")
    print("  pip install selenium webdriver-manager")
    sys.exit(1)

ROOT     = Path(__file__).resolve().parent
OUT_FILE = ROOT / "public" / "eden_funds.json"


def make_driver():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
    service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=opts)


def fetch_fund_data(driver, fund_id):
    """
    מושך תשואות קרן בודדת ממאיה.
    מחזיר dict עם: ytd, ret_1y, ret_3y, ret_5y
    (דמי ניהול לא נשלפים — הוזנו ידנית ב-JSON)
    """
    url = f"https://maya.tase.co.il/funds/mutual/{fund_id}"
    driver.get(url)

    try:
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, "[class*='fund-detail'], [class*='fundDetails'], .fund-data, table")
            )
        )
        time.sleep(2)
    except Exception:
        pass

    result = {"ytd": None, "ret_1y": None, "ret_3y": None, "ret_5y": None}
    page = driver.page_source

    patterns = {
        "ytd": [
            r'"ytdReturn"[\s]*:[\s]*([-0-9]+\.?[0-9]*)',
            r'מתחילת שנה[^>]*>\s*([-0-9]+\.?[0-9]*)',
        ],
        "ret_1y": [
            r'"oneYearReturn"[\s]*:[\s]*([-0-9]+\.?[0-9]*)',
            r'12 חודשים[^>]*>\s*([-0-9]+\.?[0-9]*)',
            r'תשואה.*?שנה[^>]*>\s*([-0-9]+\.?[0-9]*)',
        ],
        "ret_3y": [
            r'"threeYearReturn"[\s]*:[\s]*([-0-9]+\.?[0-9]*)',
            r'"3YearReturn"[\s]*:[\s]*([-0-9]+\.?[0-9]*)',
            r'3 שנים[^>]*>\s*([-0-9]+\.?[0-9]*)',
            r'שלוש שנים[^>]*>\s*([-0-9]+\.?[0-9]*)',
        ],
        "ret_5y": [
            r'"fiveYearReturn"[\s]*:[\s]*([-0-9]+\.?[0-9]*)',
            r'"5YearReturn"[\s]*:[\s]*([-0-9]+\.?[0-9]*)',
            r'5 שנים[^>]*>\s*([-0-9]+\.?[0-9]*)',
            r'חמש שנים[^>]*>\s*([-0-9]+\.?[0-9]*)',
        ],
    }

    for field, pats in patterns.items():
        for pat in pats:
            m = re.search(pat, page, re.IGNORECASE)
            if m:
                result[field] = float(m.group(1))
                break

    return result


def run():
    # קרא JSON קיים
    data = json.loads(OUT_FILE.read_text(encoding="utf-8"))

    # אסוף את כל הקרנות מכל הקטגוריות
    all_funds = []
    for cat_key, cat in data["categories"].items():
        for fund in cat["funds"]:
            all_funds.append((cat_key, fund))

    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M')}] מתחיל משיכת נתונים — {len(all_funds)} קרנות...")

    driver = make_driver()
    success_count = 0

    try:
        for i, (cat_key, fund) in enumerate(all_funds):
            fid  = fund["id"]
            name = fund["name"]
            print(f"  [{i+1}/{len(all_funds)}] {name} ({fid})")

            try:
                fetched = fetch_fund_data(driver, fid)
                # עדכן רק את שדות התשואה — fee נשמר כמות שהוא
                fund.update(fetched)
                any_data = any(v is not None for v in fetched.values())
                if any_data:
                    success_count += 1
                print(f"     ytd={fetched['ytd']}  1y={fetched['ret_1y']}  3y={fetched['ret_3y']}  5y={fetched['ret_5y']}")
            except Exception as e:
                print(f"     ERROR: {e}")

            time.sleep(1.5)

    finally:
        driver.quit()

    # עדכן תאריך
    data["last_updated"] = datetime.now().strftime("%Y-%m-%d")

    OUT_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nנשמר: {OUT_FILE}")
    print(f"נתונים שנמשכו: {success_count}/{len(all_funds)}")

    if success_count < len(all_funds) // 2:
        print("\nאזהרה: פחות מחצי הקרנות נמשכו בהצלחה.")
        print("ייתכן שמאיה שינתה את מבנה הדף — בדקי ידנית.")


if __name__ == "__main__":
    run()


# ══════════════════════════════════════════════
# הוראות הרצה שבועית — Windows Task Scheduler
# ══════════════════════════════════════════════
#
# 1. פתחי "Task Scheduler" (חיפוש בסטארט)
# 2. "Create Basic Task"
# 3. שם: "Eden Funds Update"
# 4. Trigger: Weekly → ביום ראשון בבוקר
# 5. Action: "Start a program"
#    Program: python
#    Arguments: "C:\Users\USER\Documents\הכשרה פיננסית\נתיב\eden-server\fetch_funds.py"
# 6. Finish
#
# לחלופין — הרצה ידנית (פותחת חלון CMD):
#   לחצי פעמיים על update_funds_and_push.bat
#
# אחרי הרצה — git add / commit / push נעשים אוטומטית ע"י ה-bat
