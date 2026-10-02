# Zoho Creator: sync_interview_registrations

This Custom API is intended for the **Estudiantes** Creator application.

It compares records in the `Interviews` form with student records in the `Informacion` form (the form behind the **Documents** report). It includes Active and Inactive students because it queries the underlying form, not a status-filtered report.

The sync is deliberately conservative. It automatically marks an interview as registered only when it finds strong same-person evidence:

1. exact normalized full name; or
2. matching interview number/code plus matching first name or first surname; or
3. matching phone/email plus matching first name.

This prevents a parent's shared phone/email from marking a sibling as registered.

The function supports dry-run mode. When `dry_run=true`, it returns the proposed matches without writing anything. When `dry_run=false`, it sets only `Interviews.Registered = true`.

## Helper function 1

Create a Deluge function:

- Name: `normalize_match_text`
- Namespace: Default
- Return type: string
- Argument: `input_text` (string)

```deluge
string normalize_match_text(string input_text)
{
    value = ifnull(input_text,"").trim().toLowerCase();
    value = value.replaceAll("á","a",true);
    value = value.replaceAll("à","a",true);
    value = value.replaceAll("ä","a",true);
    value = value.replaceAll("â","a",true);
    value = value.replaceAll("é","e",true);
    value = value.replaceAll("è","e",true);
    value = value.replaceAll("ë","e",true);
    value = value.replaceAll("ê","e",true);
    value = value.replaceAll("í","i",true);
    value = value.replaceAll("ì","i",true);
    value = value.replaceAll("ï","i",true);
    value = value.replaceAll("î","i",true);
    value = value.replaceAll("ó","o",true);
    value = value.replaceAll("ò","o",true);
    value = value.replaceAll("ö","o",true);
    value = value.replaceAll("ô","o",true);
    value = value.replaceAll("ú","u",true);
    value = value.replaceAll("ù","u",true);
    value = value.replaceAll("ü","u",true);
    value = value.replaceAll("û","u",true);
    value = value.replaceAll("ñ","n",true);
    value = value.replaceAll("ç","c",true);
    value = value.replaceAll("[^a-z0-9]","");
    return value;
}
```

## Helper function 2

Create a Deluge function:

- Name: `normalize_phone_text`
- Namespace: Default
- Return type: string
- Argument: `input_text` (string)

```deluge
string normalize_phone_text(string input_text)
{
    value = ifnull(input_text,"").replaceAll("[^0-9]","");
    if(value.length() > 9)
    {
        value = value.right(9);
    }
    return value;
}
```

## Main function

Create a Deluge function:

- Name: `sync_interview_registrations`
- Namespace: Default
- Return type: map
- Arguments:
  - `start_date_iso` (string)
  - `end_date_iso` (string)
  - `dry_run` (bool)

```deluge
map sync_interview_registrations(string start_date_iso, string end_date_iso, bool dry_run)
{
    start_date = start_date_iso.toDate("yyyy-MM-dd");
    end_date = end_date_iso.toDate("yyyy-MM-dd");

    checked_count = 0;
    matched_count = 0;
    updated_count = 0;
    matched_items = List();
    unmatched_items = List();

    interviews = Interviews[Date_field >= start_date && Date_field <= end_date && Registered != true];

    for each interview in interviews
    {
        checked_count = checked_count + 1;
        candidate_ids = List();

        interview_full_name = thisapp.normalize_match_text(ifnull(interview.Name,"") + " " + ifnull(interview.Surname,""));
        interview_first_name = thisapp.normalize_match_text(ifnull(interview.Name,""));

        surname_parts = ifnull(interview.Surname,"").trim().toCollection(" ");
        interview_first_surname_raw = "";
        if(surname_parts.size() > 0)
        {
            interview_first_surname_raw = surname_parts.get(0).toString();
        }
        interview_first_surname = thisapp.normalize_match_text(interview_first_surname_raw);

        interview_email = ifnull(interview.Email,"").trim().toLowerCase();
        interview_phone = thisapp.normalize_phone_text(ifnull(interview.Phone,"").toString());

        interview_code = ifnull(interview.int_number,"").trim();
        short_code = interview_code;
        if(short_code.contains("/"))
        {
            code_parts = short_code.toCollection("/");
            short_code = code_parts.get(code_parts.size() - 1).toString().trim();
        }
        if(short_code.contains("-"))
        {
            dash_parts = short_code.toCollection("-");
            last_part = dash_parts.get(dash_parts.size() - 1).toString().trim();
            if(last_part.matches("[A-Za-z]+[0-9]+"))
            {
                short_code = last_part;
            }
        }
        code_digits = short_code.replaceAll("[^0-9]","");

        // 1) Interview-number candidates.
        if(short_code != "")
        {
            for each student in Informacion[int_number == short_code]
            {
                candidate_ids.add(student.ID);
            }
        }
        if(code_digits != "" && code_digits != short_code)
        {
            for each student in Informacion[int_number == code_digits]
            {
                candidate_ids.add(student.ID);
            }
        }

        // 2) Exact email candidates. Parent emails are included, but shared-family
        // contact details alone are not enough to mark a match.
        if(interview_email != "" && interview_email != "0" && interview_email.contains("@"))
        {
            for each student in Informacion[Email == interview_email || Email2 == interview_email || Madre_Email == interview_email || Padre_Email == interview_email]
            {
                candidate_ids.add(student.ID);
            }
        }

        // 3) Spanish 9-digit phone candidates from the general phone fields.
        if(interview_phone.length() == 9 && interview_phone != "000000000")
        {
            phone_number = interview_phone.toNumber();
            for each student in Informacion[Tel_fono_m_vil == phone_number || Tel_fono_casa == phone_number || Tel_fono_trabajo == phone_number || Tel_fono_otro == phone_number]
            {
                candidate_ids.add(student.ID);
            }
        }

        // 4) Same first-name candidates, used to catch records where the contact
        // details changed but the identity is otherwise exact.
        if(ifnull(interview.Name,"").trim() != "")
        {
            for each student in Informacion[Nombre == interview.Name]
            {
                candidate_ids.add(student.ID);
            }
        }

        candidate_ids = candidate_ids.distinct();
        found_match = false;
        matched_student_id = "";
        matched_student_number = "";
        matched_student_name = "";
        matched_reason = "";

        for each candidate_id in candidate_ids
        {
            if(found_match == false)
            {
                student = Informacion[ID == candidate_id];
                if(student.count() > 0)
                {
                    student_full_name = thisapp.normalize_match_text(ifnull(student.Nombre,"") + " " + ifnull(student.Primer_apellido,"") + " " + ifnull(student.Segundo_apellido,""));
                    student_first_name = thisapp.normalize_match_text(ifnull(student.Nombre,""));
                    student_first_surname = thisapp.normalize_match_text(ifnull(student.Primer_apellido,""));

                    student_code = ifnull(student.int_number,"").trim();
                    student_code_digits = student_code.replaceAll("[^0-9]","");

                    full_name_same = interview_full_name != "" && interview_full_name == student_full_name;
                    first_name_same = interview_first_name != "" && student_first_name != "" && (student_first_name.startsWith(interview_first_name) || interview_first_name.startsWith(student_first_name));
                    first_surname_same = interview_first_surname != "" && interview_first_surname == student_first_surname;
                    code_same = short_code != "" && student_code != "" && (short_code == student_code || (code_digits != "" && code_digits == student_code_digits));

                    email_same = false;
                    if(interview_email != "" && interview_email != "0" && interview_email.contains("@"))
                    {
                        email_same = interview_email == ifnull(student.Email,"").trim().toLowerCase()
                            || interview_email == ifnull(student.Email2,"").trim().toLowerCase()
                            || interview_email == ifnull(student.Madre_Email,"").trim().toLowerCase()
                            || interview_email == ifnull(student.Padre_Email,"").trim().toLowerCase();
                    }

                    phone_same = false;
                    if(interview_phone.length() == 9 && interview_phone != "000000000")
                    {
                        phone_same = interview_phone == thisapp.normalize_phone_text(ifnull(student.Tel_fono_m_vil,"").toString())
                            || interview_phone == thisapp.normalize_phone_text(ifnull(student.Tel_fono_casa,"").toString())
                            || interview_phone == thisapp.normalize_phone_text(ifnull(student.Tel_fono_trabajo,"").toString())
                            || interview_phone == thisapp.normalize_phone_text(ifnull(student.Tel_fono_otro,"").toString())
                            || interview_phone == thisapp.normalize_phone_text(ifnull(student.Madre_Tel_fono_M_vil,"").toString())
                            || interview_phone == thisapp.normalize_phone_text(ifnull(student.Padre_Tel_fono_M_vil,"").toString());
                    }

                    contact_same = email_same || phone_same;

                    if(full_name_same)
                    {
                        found_match = true;
                        matched_reason = "exact_normalized_name";
                    }
                    else if(code_same && (first_name_same || first_surname_same))
                    {
                        found_match = true;
                        matched_reason = "interview_code_plus_name";
                    }
                    else if(contact_same && first_name_same)
                    {
                        found_match = true;
                        matched_reason = "contact_plus_first_name";
                    }

                    if(found_match)
                    {
                        matched_student_id = student.ID.toString();
                        matched_student_number = ifnull(student.NumeroEst,"").toString();
                        matched_student_name = ifnull(student.Nombre,"") + " " + ifnull(student.Primer_apellido,"") + " " + ifnull(student.Segundo_apellido,"");
                    }
                }
            }
        }

        item = Map();
        item.put("interview_id",interview.ID.toString());
        item.put("interview_number",ifnull(interview.int_number,""));
        item.put("interview_name",ifnull(interview.Name,"") + " " + ifnull(interview.Surname,""));

        if(found_match)
        {
            matched_count = matched_count + 1;
            item.put("student_id",matched_student_id);
            item.put("student_number",matched_student_number);
            item.put("student_name",matched_student_name.trim());
            item.put("reason",matched_reason);
            matched_items.add(item);

            if(dry_run == false)
            {
                interview.Registered = true;
                updated_count = updated_count + 1;
            }
        }
        else
        {
            unmatched_items.add(item);
        }
    }

    response = Map();
    response.put("dry_run",dry_run);
    response.put("start_date",start_date_iso);
    response.put("end_date",end_date_iso);
    response.put("checked",checked_count);
    response.put("matched",matched_count);
    response.put("updated",updated_count);
    response.put("unmatched",checked_count - matched_count);
    response.put("matches",matched_items);
    response.put("unmatched_interviews",unmatched_items);
    return response;
}
```

## Custom API configuration

In Creator 6:

1. Go to **Microservices > Custom API**.
2. Create a new Custom API:
   - Display name: `Sync Interview Registrations`
   - Link name: `sync_interview_registrations`
   - Method: `POST`
   - Content type: `application/json`
   - Argument type: **Key and Value**
   - Authentication: **OAuth2**
   - User scope: **Admin only**
3. In **Actions**, choose the **Estudiantes** application and the `sync_interview_registrations` Deluge function.
4. Map the three request keys to the three function arguments:
   - `start_date_iso`
   - `end_date_iso`
   - `dry_run`
5. Use the **Standard response** and enable the API.

Example dry run:

```json
{
  "start_date_iso": "2024-09-01",
  "end_date_iso": "2025-08-31",
  "dry_run": true
}
```

Example commit run:

```json
{
  "start_date_iso": "2024-09-01",
  "end_date_iso": "2025-08-31",
  "dry_run": false
}
```

The admin MCP's Zoho refresh token must include `Zohocreator.customapi.EXECUTE`. Custom API hits are metered separately from normal Creator REST API hits.
