# What the bot has learned: prod / car

- Sessions learned from: **2** · Journey steps mapped: **42** · Branch coverage: **55/118 (47%)**
- Open findings: **21** · Not reproduced on re-check: 2
- Furthest step reached most often: `/car-insurance/journey/applicant_details` (2)

## Hot spots

| Score | Step | Question | Why |
|---:|---|---|---|
| 10.5 | `/car-insurance/journey/car_address` | What's the address where the KIA is normally kept at night? | 4 open finding(s), worst major; friction (errors / slow / many actions) |
| 7 | `/car-insurance/journey/applicant_details` | What are the policy holder's contact details? | 2 open finding(s), worst major; friction (errors / slow / many actions) |
| 6 | `/car-insurance` | Compare Car Insurance Quotes | 3 open finding(s), worst minor |
| 6 | `/car-insurance/journey/regular_driver_claims` | How many motor insurance claims, regardless of fault, has the regular driver had in the last 5 years? | 1 open finding(s), worst major; friction (errors / slow / many actions) |
| 4 | `/car-insurance/journey/car_series` | Select the KIA series and specifics from the list below: | 2 open finding(s), worst minor |
| 4 | `/car-insurance/journey/regular_driver_dob` | And their date of birth? | 1 open finding(s), worst minor; friction (errors / slow / many actions) |
| 3 | `/car-insurance/journey/annual_kms` | Roughly how many kilometres is the KIA driven per year? | 2 open finding(s), worst minor |
| 3 | `/car-insurance/journey/cover_type` | What level of cover are you looking for? | 1 open finding(s), worst minor; friction (errors / slow / many actions) |
| 3 | `/car-insurance/journey/youngest_driver_dob` | And their date of birth? | 1 open finding(s), worst minor; friction (errors / slow / many actions) |
| 2 | `/car-insurance/journey/previous_insurer` | With which insurer? | friction (errors / slow / many actions) |

## Fragile steps

| Score | Step | Question | Why |
|---:|---|---|---|
| 0.27 | `/car-insurance/journey/cover_type` | What level of cover are you looking for? | erratic timing |
| 0.26 | `/car-insurance/journey/regular_driver_dob` | And their date of birth? | erratic timing |

## What's paying off (reward per session by strategy)

| Strategy | Sessions | Mean reward | Best |
|---|---:|---:|---:|
| manual | 1 | 85 | 85 |
| explore | 1 | 64.9 | 64.9 |

## Best dynamic personas

- **dyn-11081925-jarrah-explore** (explore, reward 64.9, mobile): 31, self-employed, renting in Indooroopilly. Just bought a used 2018 Kia Sorento diesel on a car loan: unrepaired hail damage, tow bar fitte

## Coverage gaps: branches shown but never taken

| Step | Question | Untried option |
|---|---|---|
| `/car-insurance/journey/modifications` | Has the KIA been modified? | Yes |
| `/car-insurance/journey/goods_payment` | Will the KIA be used for making deliveries or carrying goods for payment ...? | Yes |
| `/car-insurance/journey/non_standard_accessories` | Please add any non-standard accessories fitted to the KIA. | No non-standard accessories |
| `/car-insurance/journey/passengers_payment` | Will the KIA be used for carrying passengers for payment ...? | Yes |
| `/car-insurance/journey/youngest_driver_gender` | What's the youngest driver's gender? | Male |
| `/car-insurance/journey/car_address` | What's the address where the KIA is normally kept at night? | Try searching for your address again |
| `/car-insurance/journey/cover_type` | What level of cover are you looking for? | Third Party Property Damage |
| `/car-insurance/journey/factory_options` | Are there any factory/dealer options or non-standard accessories fitted to the KIA? | Unsure |
| `/car-insurance/journey/finance` | Is there any finance on the KIA? | Yes, Lease |
| `/car-insurance/journey/driver_option` | Do you want to exclude any drivers on the policy? | No restrictions |
| `/car-insurance/journey/driver_option` | Do you want to exclude any drivers on the policy? | Yes, all drivers will be 21 & over |
| `/car-insurance/journey/use_type` | How is the KIA used? | Business Only |
| `/car-insurance/journey/use_type` | How is the KIA used? | Private and Business |
| `/car-insurance/journey/regular_driver_licence_type` | What type of licence does the regular driver hold? | Foreign Licence |
| `/car-insurance/journey/regular_driver_licence_type` | What type of licence does the regular driver hold? | Learners |
| `/car-insurance/journey/regular_driver_licence_type` | What type of licence does the regular driver hold? | Provisional 1 (Red) |
| `/car-insurance/journey/regular_driver_licence_type` | What type of licence does the regular driver hold? | Provisional 2 (Green) |
| `/car-insurance/journey/standard_options` | We've found the following factory/dealer options for you to choose from. | Factory Options |
| `/car-insurance/journey/standard_options` | We've found the following factory/dealer options for you to choose from. | Paint - Premium |
| `/car-insurance/journey/standard_options` | We've found the following factory/dealer options for you to choose from. | Paint - standard |
| `/car-insurance/journey/standard_options` | We've found the following factory/dealer options for you to choose from. | What is fitted as standard? |
| `/car-insurance/journey/youngest_driver_licence_type` | What type of licence does the youngest driver hold? | Full / Open Licence |
| `/car-insurance/journey/youngest_driver_licence_type` | What type of licence does the youngest driver hold? | Learners |
| `/car-insurance/journey/youngest_driver_licence_type` | What type of licence does the youngest driver hold? | Provisional 1 (Red) |
| `/car-insurance/journey/youngest_driver_licence_type` | What type of licence does the youngest driver hold? | Provisional 2 (Green) |
| `/car-insurance/journey/car_series` | Select the KIA series and specifics from the list below: | Series: UM | Badge: GT-Line |
| `/car-insurance/journey/car_series` | Select the KIA series and specifics from the list below: | Series: UM | Badge: SLi |
| `/car-insurance/journey/car_series` | Select the KIA series and specifics from the list below: | Series: UM | Badge: Sport |
| `/car-insurance/journey/car_series` | Select the KIA series and specifics from the list below: | Series: YP | Badge: S (Release: May) |
| `/car-insurance/journey/regular_driver_comprehensive_insured_years` | How many full years of comprehensive car insurance has the regular driver held in the last 5 years? | 1 |
| `/car-insurance/journey/regular_driver_comprehensive_insured_years` | How many full years of comprehensive car insurance has the regular driver held in the last 5 years? | 3 |
| `/car-insurance/journey/regular_driver_comprehensive_insured_years` | How many full years of comprehensive car insurance has the regular driver held in the last 5 years? | 4 |
| `/car-insurance/journey/regular_driver_comprehensive_insured_years` | How many full years of comprehensive car insurance has the regular driver held in the last 5 years? | None |
| `/car-insurance/journey/regular_driver_employment` | What about their employment status? | Employed part-time |
| `/car-insurance/journey/regular_driver_employment` | What about their employment status? | Home duties |
| `/car-insurance/journey/regular_driver_employment` | What about their employment status? | Retired |
| `/car-insurance/journey/regular_driver_employment` | What about their employment status? | Student |
| `/car-insurance/journey/regular_driver_employment` | What about their employment status? | Unemployed |
| `/car-insurance/journey/car_badge` | Select the badge of the KIA | AO Edition |
| `/car-insurance/journey/car_badge` | Select the badge of the KIA | GT-Line |
| | | _…and 23 more_ |

## Persona × charter pairs never run

- edge-case-daniel × quote-happy-path
- edge-case-daniel × vehicle-lookup-explore
- edge-case-daniel × form-resilience
- edge-case-daniel × coverage-sweep
- edge-case-daniel × hot-spot-deep-dive
- edge-case-daniel × fragility-probe
- edge-case-daniel × regression-recheck
- family-mei × vehicle-lookup-explore
- family-mei × form-resilience
- family-mei × results-scrutiny
- family-mei × coverage-sweep
- family-mei × hot-spot-deep-dive
- family-mei × fragility-probe
- family-mei × regression-recheck
- first-car-priya × quote-happy-path
- first-car-priya × vehicle-lookup-explore
- first-car-priya × trust-and-clarity
- first-car-priya × coverage-sweep
- first-car-priya × hot-spot-deep-dive
- first-car-priya × fragility-probe
- first-car-priya × regression-recheck
- retiree-margaret × quote-happy-path
- retiree-margaret × vehicle-lookup-explore
- retiree-margaret × results-scrutiny
- retiree-margaret × trust-and-clarity
- retiree-margaret × coverage-sweep
- retiree-margaret × hot-spot-deep-dive
- retiree-margaret × fragility-probe
- retiree-margaret × regression-recheck
- tradie-greg × quote-happy-path
- tradie-greg × vehicle-lookup-explore
- tradie-greg × form-resilience
- tradie-greg × results-scrutiny
- tradie-greg × coverage-sweep
- tradie-greg × hot-spot-deep-dive
- tradie-greg × fragility-probe
- tradie-greg × regression-recheck

## Device gaps

- Steps never seen on mobile: 1 · on desktop: 8

## Finding ledger

| Id | Sev | Step | Title | Seen | Status |
|---|---|---|---|---:|---|
| K001 | major | `/car-insurance/journey/regular_driver_claims` | Next question's option renders under the cursor and looks pre-selected (mis-click risk on risk answers) | 1 | open |
| K002 | major | `/car-insurance/journey/regular_driver_dob` | Year of birth scrambled when typed quickly (1991 saved as 1919) | 1 | not_reproduced |
| K003 | major | `/car-insurance/journey/applicant_details` | Single checkbox bundles privacy/FSG acceptance with marketing email/SMS and partner call consent | 1 | open |
| K014 | major | `/car-insurance/journey/car_address` | Manual address: suburb silently pre-selected (first alphabetical) after postcode | 1 | candidate |
| K004 | minor | `/car-insurance/journey/*` | Every journey step shows 4-5s blank grey screen; journey/initial re-posted on every step | 1 | open |
| K005 | minor | `/car-insurance/journey/car_series` | Two identical variants differ only by 'Release: January' vs 'May' with no guidance | 1 | open |
| K006 | minor | `/car-insurance/journey/cover_type` | Cover help text mislabels TPFT and states <$20k rule that the journey doesn't apply | 1 | open |
| K007 | minor | `/car-insurance/journey/annual_kms` | Enter key doesn't submit text steps; Next only enables on blur | 1 | open |
| K008 | minor | `/car-insurance/journey/regular_driver_dob` | DOB inputs have no labels; address page title says 'Cover Type' | 1 | open |
| K015 | minor | `/car-insurance/journey/youngest_driver_dob` | Typing a whole date of birth in one go keeps only the day; the rest is silently lost | 1 | candidate |
| K016 | minor | `/car-insurance/journey/modifications` | Modifications help covers the whole question on mobile and doesn't say whether accessories count | 1 | candidate |
| K017 | minor | `/car-insurance/journey/car_badge` | Small inline text links need a precise tap on mobile ('click here', 'Enter it manually') | 1 | candidate |
| K020 | minor | `/car-insurance` | Accessibility: Invalid ARIA markup, so the tab state may be announced wrongly (car-insurance, WCAG 4.1.2) | 1 | open |
| K021 | minor | `/car-insurance/journey/standard_options` | Accessibility: Tabs aren't inside a tab list, so they aren't announced as tabs (standard_options, WCAG 1.3.1) | 1 | open |
| K022 | minor | `/car-insurance` | Accessibility: An ARIA value is malformed (e.g. ' true ' with spaces) (car-insurance, WCAG 4.1.2) | 1 | open |
| K023 | minor | `/*` | Accessibility: Text too faint to read comfortably (15 steps, WCAG 1.4.3) | 1 | open |
| K024 | minor | `/car-insurance/journey/car_address` | Accessibility: A form field has no name, so it's announced as just 'edit text' (car_address, WCAG 1.3.1 / 4.1.2) | 1 | open |
| K025 | minor | `/car-insurance/journey/car_address` | Accessibility: A link looks like plain text (colour is the only difference) (car_address, WCAG 1.4.1) | 1 | open |
| K026 | minor | `/car-insurance/journey/start` | Accessibility: A control is nested inside another, so focus and announcements break (start, WCAG 4.1.2) | 1 | open |
| K027 | minor | `/car-insurance` | Accessibility: A scrolling box can't be reached or scrolled with the keyboard (car-insurance, WCAG 2.1.1) | 1 | open |
| K028 | minor | `/car-insurance/journey/car_address` | Accessibility: A dropdown has no name; users don't know what they're choosing (car_address, WCAG 4.1.2) | 1 | open |
| K029 | minor | `/car-insurance/journey/car_series` | Accessibility: Tap targets are too small to hit reliably (car_series, WCAG 2.5.8) | 1 | open |
| K009 | cosmetic | `/car-insurance/journey/overnight_parking_type` | 'Car Park' and 'Parking Lot' offered as separate parking options | 1 | open |
| K010 | cosmetic | `/car-insurance/journey/regular_driver_comprehensive_insured_years` | 'None' years offered after answering Yes to comprehensive cover in last 12 months | 1 | not_reproduced |
| K011 | cosmetic | `/car-insurance/journey/annual_kms` | Copy: "KM's" and "drivers licence" | 1 | open |
| K012 | cosmetic | `/car-insurance/journey/applicant_details` | Empty email field shown green/valid before input | 1 | open |
| K013 | observation | `/car-insurance/journey/driver_option` | Production journey record + marketing call created before any contact details | 1 | open |
| K018 | observation | `/car-insurance/journey/youngest_driver_licence_age` | Foreign licence branch asks nothing about country or time driving in Australia | 1 | candidate |
| K019 | observation | `/car-insurance/journey/accident_hail_damage` | 'Yes' to unrepaired hail damage has no follow-up or explanation of impact | 1 | candidate |

## Journey map (step → next step, via option)

- `/car-insurance/journey/accident_hail_damage` → `/car-insurance/journey/finance` ×2 via No (1), Yes (1)
- `/car-insurance/journey/annual_kms` → `/car-insurance/journey/car_address` ×2 via Next (2)
- `/car-insurance/journey/car_address` → `/car-insurance/journey/overnight_parking_type` ×2 via Next (2)
- `/car-insurance/journey/car_badge` → `/car-insurance/journey/car_series` ×2 via S (1), click here (1)
- `/car-insurance/journey/car_body` → `/car-insurance/journey/car_badge` ×2
- `/car-insurance/journey/car_colour` → `/car-insurance/journey/cover_type` ×2 via Silver (1), White (1)
- `/car-insurance/journey/car_fuel` → `/car-insurance/journey/car_body` ×2 via Diesel (1), Petrol (1)
- `/car-insurance/journey/car_make` → `/car-insurance/journey/car_year` ×2 via KIA (2)
- `/car-insurance/journey/car_model` → `/car-insurance/journey/car_fuel` ×2 via CARNIVAL (1), SORENTO (1)
- `/car-insurance/journey/car_series` → `/car-insurance/journey/car_colour` ×2 via Series: UM | Badge: Si (1), Series: YP | Badge: S (Release: January) (1)
- `/car-insurance/journey/car_year` → `/car-insurance/journey/car_model` ×2 via 2018 (1), 2019 (1)
- `/car-insurance/journey/cover_type` → `/car-insurance/journey/factory_options` ×2 via Comprehensive (1), Third Party Fire and Theft (1)
- `/car-insurance/journey/driver_option` → `/car-insurance/journey/applicant_details` ×2 via Yes, all drivers will be 25 & over (1), Yes, all drivers will be 30 & over (1)
- `/car-insurance/journey/finance` → `/car-insurance/journey/use_type` ×2 via No (1), Yes, Finance / Hire Purchase (1)
- `/car-insurance/journey/modifications` → `/car-insurance/journey/accident_hail_damage` ×2 via No (2)
- `/car-insurance/journey/overnight_parking_type` → `/car-insurance/journey/regular_driver_gender` ×2 via Car Park (1), Garaged (1)
- `/car-insurance/journey/regular_driver_claims` → `/car-insurance/journey/regular_driver_owns_another_car` ×2 via Next (2)
- `/car-insurance/journey/regular_driver_comprehensive_insured` → `/car-insurance/journey/regular_driver_comprehensive_insured_years` ×2 via No (1), Yes (1)
- `/car-insurance/journey/regular_driver_comprehensive_insured_years` → `/car-insurance/journey/regular_driver_claims` ×2 via 2 (1), 5 (1)
- `/car-insurance/journey/regular_driver_dob` → `/car-insurance/journey/regular_driver_employment` ×2 via Next (2)
- `/car-insurance/journey/regular_driver_employment` → `/car-insurance/journey/regular_driver_licence_type` ×2 via Employed full-time (1), Self employed (1)
- `/car-insurance/journey/regular_driver_gender` → `/car-insurance/journey/regular_driver_dob` ×2 via Female (1), Male (1)
- `/car-insurance/journey/regular_driver_licence_age` → `/car-insurance/journey/regular_driver_comprehensive_insured` ×2 via Next (2)
- `/car-insurance/journey/regular_driver_licence_type` → `/car-insurance/journey/regular_driver_licence_age` ×2 via Full / Open Licence (2)
- `/car-insurance/journey/regular_driver_owns_another_car` → `/car-insurance/journey/regular_driver_owns_home` ×2 via No (1), Yes (1)
- `/car-insurance/journey/regular_driver_owns_home` → `/car-insurance/journey/youngest_driver` ×2 via No (1), Yes (1)
- `/car-insurance/journey/start` → `/car-insurance/journey/car_make` ×2 via click here (2)
- `/car-insurance` → `/car-insurance/journey/start` ×2 via Compare now (2)
- `/car-insurance/journey/currently_insured` → `/car-insurance/journey/annual_kms` ×1 via No (1)
- `/car-insurance/journey/currently_insured` → `/car-insurance/journey/previous_insurer` ×1 via Yes (1)
- `/car-insurance/journey/factory_options` → `/car-insurance/journey/modifications` ×1 via No (1)
- `/car-insurance/journey/factory_options` → `/car-insurance/journey/standard_options` ×1 via Yes (1)
- `/car-insurance/journey/goods_payment` → `/car-insurance/journey/currently_insured` ×1 via No (1)
- `/car-insurance/journey/non_standard_accessories` → `/car-insurance/journey/modifications` ×1 via Next (1)
- `/car-insurance/journey/passengers_payment` → `/car-insurance/journey/goods_payment` ×1 via No (1)
- `/car-insurance/journey/previous_insurer` → `/car-insurance/journey/annual_kms` ×1 via Next Step (1)
- `/car-insurance/journey/standard_options` → `/car-insurance/journey/non_standard_accessories` ×1 via No Factory options (1)
- `/car-insurance/journey/use_type` → `/car-insurance/journey/currently_insured` ×1 via Private and/or commuting to work only (1)
- `/car-insurance/journey/use_type` → `/car-insurance/journey/passengers_payment` ×1 via Private and Occasional Business (1)
- `/car-insurance/journey/youngest_driver` → `/car-insurance/journey/driver_option` ×1 via No (1)
- `/car-insurance/journey/youngest_driver` → `/car-insurance/journey/youngest_driver_gender` ×1 via Yes (1)
- `/car-insurance/journey/youngest_driver_dob` → `/car-insurance/journey/youngest_driver_licence_type` ×1 via Next (1)
- `/car-insurance/journey/youngest_driver_gender` → `/car-insurance/journey/youngest_driver_dob` ×1 via Female (1)
- `/car-insurance/journey/youngest_driver_licence_age` → `/car-insurance/journey/driver_option` ×1 via Next (1)
- `/car-insurance/journey/youngest_driver_licence_type` → `/car-insurance/journey/youngest_driver_licence_age` ×1 via Foreign Licence (1)
