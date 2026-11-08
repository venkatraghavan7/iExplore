# Weekly quality digest · prod car · 2026-W45

- **Needs a decision:** 6 (admitted this week 6/5)
- **Below the line:** 17 confirmed lower-impact findings, held in the digest
- **Waiting for a second sighting:** 6 candidates
- **Possibly fixed** (ticketed, no longer reproduces): 0
- **Triage acceptance rate:** no decisions yet (target 50% or higher; lower means the bot is too noisy)
- **Sessions this week:** 2

## Needs a decision (highest impact first)

- **K002** · impact 27.6 · major · Year of birth scrambled when typed quickly (1991 saved as 1919) (`/car-insurance/journey/regular_driver_dob`)
- **K001** · impact 26.4 · major · Next question's option renders under the cursor and looks pre-selected (mis-click risk on risk answers) (`/car-insurance/journey/regular_driver_claims`)
- **K003** · impact 19.7 · major · Single checkbox bundles privacy/FSG acceptance with marketing email/SMS and partner call consent (`/car-insurance/journey/applicant_details`)
- **K020** · impact 19.0 · minor · Accessibility: Invalid ARIA markup, so the tab state may be announced wrongly (car-insurance, WCAG 4.1.2) (`/car-insurance`)
- **K007** · impact 13.2 · minor · Enter key doesn't submit text steps; Next only enables on blur (`/car-insurance/journey/annual_kms`)
- **K008** · impact 12.5 · minor · DOB inputs have no labels; address page title says 'Cover Type' (`/car-insurance/journey/regular_driver_dob`)

## Accessibility scan: 10 failing WCAG rule(s)

- K020 · triage (reserved slot) · Accessibility: Invalid ARIA markup, so the tab state may be announced wrongly (car-insurance, WCAG 4.1.2)
- K022 · digest · Accessibility: An ARIA value is malformed (e.g. ' true ' with spaces) (car-insurance, WCAG 4.1.2)
- K023 · digest · Accessibility: Text too faint to read comfortably (15 steps, WCAG 1.4.3)
- K027 · digest · Accessibility: A scrolling box can't be reached or scrolled with the keyboard (car-insurance, WCAG 2.1.1)
- K029 · digest · Accessibility: Tap targets are too small to hit reliably (car_series, WCAG 2.5.8)
- K026 · digest · Accessibility: A control is nested inside another, so focus and announcements break (start, WCAG 4.1.2)
- K024 · digest · Accessibility: A form field has no name, so it's announced as just 'edit text' (car_address, WCAG 1.3.1 / 4.1.2)
- K025 · digest · Accessibility: A link looks like plain text (colour is the only difference) (car_address, WCAG 1.4.1)
- K028 · digest · Accessibility: A dropdown has no name; users don't know what they're choosing (car_address, WCAG 4.1.2)
- K021 · digest · Accessibility: Tabs aren't inside a tab list, so they aren't announced as tabs (standard_options, WCAG 1.3.1)

## Below the line, by category

- **accessibility** (9): K022 Accessibility: An ARIA value is malformed (e.g. ' true ' with spaces) ; K023 Accessibility: Text too faint to read comfortably (15 steps, WCAG 1.4.; K027 Accessibility: A scrolling box can't be reached or scrolled with the k …
- **content** (3): K006 Cover help text mislabels TPFT and states <$20k rule that the journey ; K011 Copy: "KM's" and "drivers licence"; K009 'Car Park' and 'Parking Lot' offered as separate parking options
- **performance** (1): K004 Every journey step shows 4-5s blank grey screen; journey/initial re-po
- **usability** (1): K005 Two identical variants differ only by 'Release: January' vs 'May' with
- **functional** (1): K010 'None' years offered after answering Yes to comprehensive cover in las
- **data** (1): K013 Production journey record + marketing call created before any contact 
- **visual** (1): K012 Empty email field shown green/valid before input

## Waiting for a second sighting

- K014 · major · Manual address: suburb silently pre-selected (first alphabetical) after postcode (`/car-insurance/journey/car_address`)
- K016 · minor · Modifications help covers the whole question on mobile and doesn't say whether accessories count (`/car-insurance/journey/modifications`)
- K017 · minor · Small inline text links need a precise tap on mobile ('click here', 'Enter it manually') (`/car-insurance/journey/car_badge`)
- K015 · minor · Typing a whole date of birth in one go keeps only the day; the rest is silently lost (`/car-insurance/journey/youngest_driver_dob`)
- K019 · observation · 'Yes' to unrepaired hail damage has no follow-up or explanation of impact (`/car-insurance/journey/accident_hail_damage`)
- K018 · observation · Foreign licence branch asks nothing about country or time driving in Australia (`/car-insurance/journey/youngest_driver_licence_age`)

## Quality bar the bot is following

- Don't report copy or spelling nits unless they change meaning or appear on the landing page.
- Group repeated issues of the same kind into one finding that lists every step affected.
